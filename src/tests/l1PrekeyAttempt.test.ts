import {constants, createCipheriv, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import '@lib/crypto/crypto.worker';
import cryptoWorker from '@lib/crypto/cryptoMessagePort';
import {TLDeserialization, TLSerialization} from '@lib/mtproto/tl_utils';
import abridgedPacketCodec from '@lib/mtproto/transports/abridged';
import bytesFromHex from '@helpers/bytes/bytesFromHex';
import bytesXor from '@helpers/bytes/bytesXor';
import {bigIntToBytes} from '@helpers/bigInt/bigIntConversion';
import bigInt from 'big-integer';
import {acquireAttemptPermit} from './l1PrekeyRunnerPolicy.mjs';
import {markAttemptStopForResult} from './l1PrekeyRun.mjs';

const REQ_PQ_MULTI = -1099002127;
const REQ_DH_PARAMS = -686627650;
const SERVER_NONCE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const PRIME_HEX =
  'c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f' +
  '48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c37' +
  '20fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f64' +
  '2477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4' +
  'a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754' +
  'fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4' +
  'e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f' +
  '0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b';

function buildTarget() {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const publicKeyPem = publicKey.export({format: 'pem', type: 'spki'}).toString();
  const jwk = publicKey.export({format: 'jwk'});
  const publicKeyHex = {
    modulus: Buffer.from(jwk.n!, 'base64url').toString('hex'),
    exponent: Buffer.from(jwk.e!, 'base64url').toString('hex')
  };
  const serialization = new TLSerialization();
  serialization.storeBytes(bytesFromHex(publicKeyHex.modulus), 'n');
  serialization.storeBytes(bytesFromHex(publicKeyHex.exponent), 'e');
  const digest = createHash('sha1').update(serialization.getBytes(true)).digest();
  const fingerprint = Buffer.from(digest.subarray(-8)).reverse().toString('hex');
  const endpoint = 'wss://diagnostic.example.test/apiws';

  return {
    privateKey,
    target: {
      mode: 'private' as const,
      endpoint,
      fingerprint,
      publicKey: publicKeyPem,
      publicKeyHex,
      routeLock: {
        mode: 'private' as const,
        endpoint,
        transport: 'websocket' as const,
        dcIds: [1, 2, 3, 4, 5],
        connectionTypes: ['client', 'upload', 'download'] as const
      }
    }
  };
}

function wrapResponse(body: Uint8Array) {
  const message = new TLSerialization();
  message.storeLong('0', 'auth_key_id');
  message.storeLong('4', 'msg_id');
  message.storeInt(body.length, 'msg_len');
  message.storeRawBytes(body);
  return message.getBytes(true);
}

function serializeObject(value: object, type: string) {
  const serialization = new TLSerialization({mtproto: true});
  serialization.storeObject(value, type);
  return serialization.getBytes(true);
}

function readRequest(data: Uint8Array) {
  const deserializer = new TLDeserialization(data, {mtproto: true});
  deserializer.fetchLong('auth_key_id');
  deserializer.fetchLong('msg_id');
  deserializer.fetchInt('msg_len');
  const methodId = deserializer.fetchInt('method_id');
  return {deserializer, methodId};
}

class SyntheticConnection {
  public requests: {methodId: number, data: Uint8Array}[] = [];
  public close1000Sent = false;
  private listeners = new Map<string, Set<(data?: ArrayBuffer) => void>>();
  private outboundDecipher: ReturnType<typeof createDecipheriv>;
  private inboundCipher: ReturnType<typeof createCipheriv>;
  private localClose = false;
  private opened = false;
  private readonly metrics: {upgradeStatus?: number, requestCount: number, close1000Sent: boolean, peerClosed: boolean, networkError: boolean, malformed: boolean};
  private readonly target: ReturnType<typeof buildTarget>['target'];
  private readonly privateKey: ReturnType<typeof buildTarget>['privateKey'];
  private readonly nonceOverride?: Uint8Array;
  private readonly malformedRespq: boolean;
  private readonly malformedFraming: boolean;
  private readonly invalidPq: boolean;
  private readonly fingerprintMismatch: boolean;
  private readonly dhParamsFail: boolean;
  private readonly invalidDhFailHash: boolean;
  private readonly dhNonceMismatch: boolean;
  private readonly invalidGenerator: boolean;
  private readonly protocolCode?: number;
  private readonly dhProtocolCode?: number;

  constructor(
    _dcId: number,
    _endpoint: string,
    _logSuffix: string,
    metrics: {upgradeStatus?: number, requestCount: number, close1000Sent: boolean, peerClosed: boolean, networkError: boolean, malformed: boolean},
    options: {
    target: ReturnType<typeof buildTarget>['target'],
    privateKey: ReturnType<typeof buildTarget>['privateKey'],
    nonceOverride?: Uint8Array,
    malformedRespq?: boolean,
    malformedFraming?: boolean,
    noResponse?: boolean,
    abruptDisconnect?: boolean,
    neverOpen?: boolean,
    invalidPq?: boolean,
    fingerprintMismatch?: boolean,
    dhParamsFail?: boolean,
    invalidDhFailHash?: boolean,
    dhNonceMismatch?: boolean,
    invalidGenerator?: boolean,
    protocolCode?: number,
    dhProtocolCode?: number
  }
  ) {
    this.metrics = metrics;
    this.target = options.target;
    this.privateKey = options.privateKey;
    this.nonceOverride = options.nonceOverride;
    this.malformedRespq = options.malformedRespq ?? false;
    this.malformedFraming = options.malformedFraming ?? false;
    this.noResponse = options.noResponse ?? false;
    this.abruptDisconnect = options.abruptDisconnect ?? false;
    this.invalidPq = options.invalidPq ?? false;
    this.fingerprintMismatch = options.fingerprintMismatch ?? false;
    this.dhParamsFail = options.dhParamsFail ?? false;
    this.invalidDhFailHash = options.invalidDhFailHash ?? false;
    this.dhNonceMismatch = options.dhNonceMismatch ?? false;
    this.invalidGenerator = options.invalidGenerator ?? false;
    this.protocolCode = options.protocolCode;
    this.dhProtocolCode = options.dhProtocolCode;
    if(!options.neverOpen) {
      queueMicrotask(() => {
        this.opened = true;
        this.metrics.upgradeStatus = 101;
        this.dispatch('open');
      });
    }
  }

  private readonly noResponse: boolean;
  private readonly abruptDisconnect: boolean;

  public addEventListener(type: string, listener: (data?: ArrayBuffer) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (data?: ArrayBuffer) => void) {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);
    if(!listeners?.size) this.listeners.delete(type);
  }

  public send(data: Uint8Array) {
    if(!this.outboundDecipher) {
      if(data.byteLength !== 64) {
        this.metrics.malformed = true;
        return;
      }
      const init = Uint8Array.from(data);
      const reversed = Uint8Array.from(init).reverse();
      this.outboundDecipher = createDecipheriv('aes-256-ctr', init.subarray(8, 40), init.subarray(40, 56));
      this.inboundCipher = createCipheriv('aes-256-ctr', reversed.subarray(8, 40), reversed.subarray(40, 56));
      this.outboundDecipher.update(init);
      return;
    }

    this.metrics.requestCount++;
    const packet = new Uint8Array(abridgedPacketCodec.readPacket(this.outboundDecipher.update(data)));
    if(!packet.byteLength) {
      this.metrics.malformed = true;
      return;
    }
    void this.respond(packet);
  }

  private async respond(data: Uint8Array) {
    const {deserializer, methodId} = readRequest(data);
    this.requests.push({methodId, data: new Uint8Array(data)});
    if(this.abruptDisconnect) {
      this.dispatch('close', undefined, 1006);
      return;
    }
    if(this.noResponse) return;
    if(this.malformedFraming) {
      this.dispatchEncrypted(new Uint8Array([0]));
      return;
    }

    if(methodId === REQ_PQ_MULTI) {
      if(this.protocolCode !== undefined) {
        this.dispatchResponse(wrapResponse(serializeObject({
          _: 'rpc_error',
          error_code: this.protocolCode,
          error_message: 'ATTACKER_CONTROLLED_ERROR'
        }, 'Object')));
        return;
      }
      if(this.malformedRespq) {
        this.dispatchResponse(wrapResponse(new Uint8Array([0xff, 0xff, 0xff, 0xff])));
        return;
      }

      const nonce = deserializer.fetchIntBytes(128, true) as Uint8Array;
      const fingerprint = this.fingerprintMismatch ?
        BigInt(`0x${this.target.fingerprint}`) ^ BigInt(1) : BigInt(`0x${this.target.fingerprint}`);
      const fingerprints = [fingerprint.toString(10)];
      this.dispatchResponse(wrapResponse(serializeObject({
        _: 'resPQ',
        nonce: this.nonceOverride ?? nonce,
        server_nonce: SERVER_NONCE,
        pq: this.invalidPq ? new Uint8Array(0) : new Uint8Array([15]),
        server_public_key_fingerprints: fingerprints
      }, 'ResPQ')));
      return;
    }

    if(methodId === REQ_DH_PARAMS) {
      const nonce = deserializer.fetchIntBytes(128, true) as Uint8Array;
      const serverNonce = deserializer.fetchIntBytes(128, true) as Uint8Array;
      deserializer.fetchBytes('p');
      deserializer.fetchBytes('q');
      deserializer.fetchLong('public_key_fingerprint');
      const encryptedData = deserializer.fetchBytes('encrypted_data') as Uint8Array;
      if(this.dhProtocolCode !== undefined) {
        this.dispatchResponse(wrapResponse(serializeObject({
          _: 'rpc_error',
          error_code: this.dhProtocolCode,
          error_message: 'ATTACKER_CONTROLLED_DH_ERROR'
        }, 'Object')));
        return;
      }
      const rsaPlaintext = new Uint8Array(privateDecrypt({
        key: this.privateKey,
        padding: constants.RSA_NO_PADDING
      }, Buffer.from(encryptedData)));
      const encryptedInnerData = rsaPlaintext.slice(32);
      const temporaryKey = bytesXor(rsaPlaintext.slice(0, 32), await cryptoWorker.invokeCrypto('sha256', encryptedInnerData));
      const innerDataWithHash = await cryptoWorker.invokeCrypto('aes-decrypt', encryptedInnerData, temporaryKey, new Uint8Array([0]));
      const pQInnerData = new TLDeserialization(innerDataWithHash.slice(0, 192).reverse(), {mtproto: true})
        .fetchObject('P_Q_inner_data');
      const newNonce = pQInnerData.new_nonce as Uint8Array;
      if(this.dhParamsFail) {
        const failureHash = await cryptoWorker.invokeCrypto('sha1', newNonce);
        this.dispatchResponse(wrapResponse(serializeObject({
          _: 'server_DH_params_fail',
          nonce: this.dhNonceMismatch ? new Uint8Array(16).fill(0x33) : nonce,
          server_nonce: serverNonce,
          new_nonce_hash: this.invalidDhFailHash ? new Uint8Array(16) : failureHash.slice(-16)
        }, 'Server_DH_Params')));
        return;
      }

      const newNonceServerNonceHash = await cryptoWorker.invokeCrypto('sha1', newNonce.concat(serverNonce));
      const serverNonceNewNonceHash = await cryptoWorker.invokeCrypto('sha1', serverNonce.concat(newNonce));
      const newNonceHash = await cryptoWorker.invokeCrypto('sha1', newNonce.concat(newNonce));
      const aesKey = newNonceServerNonceHash.concat(serverNonceNewNonceHash.slice(0, 12));
      const aesIv = serverNonceNewNonceHash.slice(12).concat(newNonceHash, newNonce.slice(0, 4));
      const inner = new TLSerialization({mtproto: true});
      inner.storeObject({
        _: 'server_DH_inner_data',
        nonce,
        server_nonce: serverNonce,
        g: this.invalidGenerator ? 2 : 3,
        dh_prime: bytesFromHex(PRIME_HEX),
        g_a: bigIntToBytes(bigInt(2).pow(2047)),
        server_time: Math.floor(Date.now() / 1000)
      }, 'Server_DH_inner_data');
      const innerBytes = inner.getBytes(true);
      const answerPadding = new Uint8Array((16 - (20 + innerBytes.length) % 16) % 16);
      const answer = new Uint8Array(20 + innerBytes.length + answerPadding.length);
      answer.set(await cryptoWorker.invokeCrypto('sha1', innerBytes));
      answer.set(innerBytes, 20);
      const encryptedAnswer = await cryptoWorker.invokeCrypto('aes-encrypt', answer, aesKey, aesIv);

      this.dispatchResponse(wrapResponse(serializeObject({
        _: 'server_DH_params_ok',
        nonce,
        server_nonce: serverNonce,
        encrypted_answer: encryptedAnswer
      }, 'Server_DH_Params')));
      return;
    }

    throw new Error('unexpected synthetic request');
  }

  private dispatchResponse(response: Uint8Array) {
    this.dispatchEncrypted(response);
  }

  private dispatchEncrypted(response: Uint8Array) {
    const frame = abridgedPacketCodec.encodePacket(response);
    const encrypted = this.inboundCipher.update(frame);
    this.dispatch('message', encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength));
  }

  public close() {
    this.localClose = true;
    this.close1000Sent = true;
    if(this.opened) this.metrics.close1000Sent = true;
    this.dispatch('close');
  }

  private dispatch(type: string, data?: ArrayBuffer, closeCode?: number) {
    if(type === 'close' && !this.localClose) {
      if(closeCode === 1006) this.metrics.networkError = true;
      else this.metrics.peerClosed = true;
    }
    for(const listener of this.listeners.get(type) ?? []) listener(data);
  }
}

function makeSyntheticConnection(options: ConstructorParameters<typeof SyntheticConnection>[4]) {
  let connection: SyntheticConnection;
  return {
    createConnection: (_input: unknown, metrics: ConstructorParameters<typeof SyntheticConnection>[3]) => class extends SyntheticConnection {
      constructor(dcId: number, endpoint: string, logSuffix: string) {
        super(dcId, endpoint, logSuffix, metrics, options);
        connection = this;
      }
    },
    get connection() {
      return connection;
    }
  };
}

function buildAttemptInput(target: ReturnType<typeof buildTarget>['target']) {
  return {
    target,
    origin: 'https://web.example.test',
    subprotocol: 'binary',
    dc_id: 2,
    source_ref: 'a'.repeat(40),
    deploy_ref: 'MAIN-1633',
    run_ref: 'MAIN-1653'
  };
}

describe('shipped-client L1 pre-key harness', () => {
  it('validates server DH inner data and stops before auth-key creation', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      upgrade: '101',
      respq: 'complete',
      respq_nonce_match: true,
      fingerprint_in_pinned_set: true,
      pq_valid: true,
      dh_reply: 'ok',
      dh_inner_valid: true,
      close_1000_sent: true,
      result: 'dh_inner_valid'
    });
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI, REQ_DH_PARAMS]);
  });

  it('stops on a protocol 429 without treating it as malformed framing', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, protocolCode: 429});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      upgrade: '101',
      respq: 'proto_error',
      proto_error_code: '429',
      close_1000_sent: true,
      result: 'respq_protocol_error'
    });
    expect(result).not.toHaveProperty('dh_reply');
    expect(result).not.toHaveProperty('dh_inner_valid');
    expect(JSON.stringify(result)).not.toContain('ATTACKER_CONTROLLED_ERROR');
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI]);
  });

  it('keeps a DH-stage 429 distinct from a server DH refusal', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, dhProtocolCode: 429});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      respq: 'complete',
      dh_reply: 'proto_error',
      proto_error_code: '429',
      close_1000_sent: true,
      result: 'dh_protocol_error'
    });
    expect(result).not.toHaveProperty('dh_inner_valid');
    expect(JSON.stringify(result)).not.toContain('ATTACKER_CONTROLLED_DH_ERROR');
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI, REQ_DH_PARAMS]);
  });

  it('does not advance when the resPQ nonce mismatches', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({
      target,
      privateKey,
      nonceOverride: new Uint8Array(16).fill(0x7a)
    });
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      upgrade: '101',
      respq: 'complete',
      respq_nonce_match: false,
      close_1000_sent: true,
      result: 'respq_nonce_mismatch'
    });
    expect(result).not.toHaveProperty('fingerprint_in_pinned_set');
    expect(result).not.toHaveProperty('pq_valid');
    expect(result).not.toHaveProperty('dh_reply');
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI]);
  });

  it('does not select a key or send DH when pq is invalid', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, invalidPq: true});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      respq: 'complete',
      respq_nonce_match: true,
      pq_valid: false,
      close_1000_sent: true,
      result: 'pq_invalid'
    });
    expect(result).not.toHaveProperty('fingerprint_in_pinned_set');
    expect(result).not.toHaveProperty('dh_reply');
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI]);
  });

  it('distinguishes a missing pinned fingerprint from malformed resPQ', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, fingerprintMismatch: true});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      respq: 'complete',
      respq_nonce_match: true,
      fingerprint_in_pinned_set: false,
      pq_valid: true,
      close_1000_sent: true,
      result: 'fingerprint_mismatch'
    });
    expect(result).not.toHaveProperty('dh_reply');
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI]);
  });

  it('omits DH-inner validation after a server DH refusal', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, dhParamsFail: true});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });
    expect(result).toMatchObject({
      respq: 'complete',
      respq_nonce_match: true,
      fingerprint_in_pinned_set: true,
      pq_valid: true,
      dh_reply: 'fail',
      close_1000_sent: true,
      result: 'dh_reply_refused'
    });
    expect(result).not.toHaveProperty('dh_inner_valid');
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI, REQ_DH_PARAMS]);
  });

  it('does not report a DH refusal when its new-nonce hash is invalid', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, dhParamsFail: true, invalidDhFailHash: true});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      respq: 'complete',
      dh_reply: 'malformed',
      close_1000_sent: true,
      result: 'dh_reply_malformed'
    });
    expect(result).not.toHaveProperty('dh_inner_valid');
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI, REQ_DH_PARAMS]);
  });

  it('does not report a DH refusal when the response nonce mismatches', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, dhParamsFail: true, dhNonceMismatch: true});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      respq: 'complete',
      dh_reply: 'malformed',
      close_1000_sent: true,
      result: 'dh_reply_nonce_mismatch'
    });
    expect(result).not.toHaveProperty('dh_inner_valid');
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI, REQ_DH_PARAMS]);
  });

  it('reports malformed framing without retaining the transport error', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, malformedFraming: true});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      upgrade: '101',
      respq: 'malformed',
      close_1000_sent: true,
      result: 'respq_malformed'
    });
    expect(JSON.stringify(result)).not.toContain('ATTACKER_CONTROLLED_FRAME_TEXT');
    expect(result).not.toHaveProperty('dh_reply');
    expect(peer.connection.requests).toHaveLength(1);
  });

  it('reports an undecodable resPQ separately from malformed framing', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, malformedRespq: true});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      upgrade: '101',
      respq: 'malformed',
      close_1000_sent: true,
      result: 'respq_malformed'
    });
    expect(result).not.toHaveProperty('dh_reply');
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI]);
  });

  it('reports DH validation failure without sending set_client_DH_params', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, invalidGenerator: true});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection
    });

    expect(result).toMatchObject({
      respq: 'complete',
      respq_nonce_match: true,
      fingerprint_in_pinned_set: true,
      pq_valid: true,
      dh_reply: 'ok',
      dh_inner_valid: false,
      close_1000_sent: true,
      result: 'dh_inner_invalid'
    });
    expect(peer.connection.requests.map(({methodId}) => methodId)).toEqual([REQ_PQ_MULTI, REQ_DH_PARAMS]);
  });

  it('returns unknown on a deadline and closes the opened connection', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, noResponse: true});

    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection,
      deadlineMs: 500
    });

    expect(result).toMatchObject({
      upgrade: '101',
      respq: 'timeout',
      close_1000_sent: true,
      result: 'unknown'
    });
    expect(result).not.toHaveProperty('dh_reply');
    expect(result).not.toHaveProperty('dh_inner_valid');
    expect(peer.connection.requests).toHaveLength(1);
  });

  it('stops later attempts after an abnormal post-upgrade close', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, abruptDisconnect: true});
    const directory = await mkdtemp(join(tmpdir(), 'teagram-l1-abnormal-close-test-'));
    const permit = await acquireAttemptPermit({directory, now: 3_500_000});
    expect(permit).toMatchObject({allowed: true});

    try {
      const result = await runDiagnosticAttempt(buildAttemptInput(target), {
        createConnection: peer.createConnection
      });

      expect(result).toMatchObject({upgrade: '101', result: 'unknown'});
      await markAttemptStopForResult(permit, result);
      await permit.release();

      const blocked = await acquireAttemptPermit({directory, now: 3_505_000});
      expect(blocked).toMatchObject({allowed: false, reason: 'already_stopped'});
    } finally {
      await permit.release();
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('does not report a 1000 close when no WebSocket was opened', async() => {
    const {runDiagnosticAttempt} = await import('./l1PrekeyAttempt');
    const {privateKey, target} = buildTarget();
    const peer = makeSyntheticConnection({target, privateKey, noResponse: true, neverOpen: true});
    const result = await runDiagnosticAttempt(buildAttemptInput(target), {
      createConnection: peer.createConnection,
      deadlineMs: 50
    });

    expect(result).toMatchObject({
      upgrade: 'network_error',
      close_1000_sent: false,
      result: 'unknown'
    });
    expect(result).not.toHaveProperty('respq');
    expect(result).not.toHaveProperty('dh_reply');
    expect(peer.connection.requests).toHaveLength(0);
  });
});
