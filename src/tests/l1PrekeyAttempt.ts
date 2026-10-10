import {Authorizer} from '@lib/mtproto/authorizer';
import TcpObfuscated from '@lib/mtproto/transports/tcpObfuscated';
import {AbridgedPacketStream} from '@lib/mtproto/transports/abridged';
import {TLDeserialization} from '@lib/mtproto/tl_utils';
import Schema from '@lib/mtproto/schema';
import type {MTProtoConstructor} from '@lib/mtproto/schema';
import {validateMtprotoTarget, MtprotoTarget} from '@config/mtprotoTarget';
import type {MTConnectionConstructable} from '@lib/mtproto/transports/transport';
import rsaKeysManager from '@lib/mtproto/rsaKeysManager';
import {TimeManager} from '@lib/mtproto/timeManager';
import CryptoWorker from '@lib/crypto/cryptoMessagePort';
import {randomBytes} from '@helpers/random';
import bytesCmp from '@helpers/bytes/bytesCmp';
import {serializeDiagnosticResult} from './l1PrekeyContract';
import {NodeWebSocketConnection} from './l1PrekeyNodeWebSocket';
import type {NodeWebSocketMetrics} from './l1PrekeyNodeWebSocket';

const ATTEMPT_DEADLINE_MS = 20_000;
const PREKEY_BOUNDARY = Symbol.for('teagram-l1-prekey-test-only');
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVER_DH_PARAMS_FAIL: MTProtoConstructor = {
  id: 0x79cb045d,
  predicate: 'server_DH_params_fail',
  params: [
    {name: 'nonce', type: 'int128'},
    {name: 'server_nonce', type: 'int128'},
    {name: 'new_nonce_hash', type: 'int128'}
  ],
  type: 'Server_DH_Params'
};

type DiagnosticInput = {
  target: MtprotoTarget,
  origin: string,
  subprotocol: string,
  dc_id: number,
  source_ref: string,
  deploy_ref: string,
  run_ref: string
};

type ValidatedDiagnosticInput = Omit<DiagnosticInput, 'target'> & {
  target: Extract<MtprotoTarget, {mode: 'private'}>
};

type AttemptMetrics = NodeWebSocketMetrics;

type AttemptTransport = {
  send: (data: Uint8Array) => Promise<Uint8Array> | void,
  destroy: () => void,
  upgradeStatus?: number,
  close1000Sent?: boolean
};

type ObservedResult = {
  upgrade?: string,
  respq?: string,
  respq_nonce_match?: boolean,
  fingerprint_in_pinned_set?: boolean,
  pq_valid?: boolean,
  dh_reply?: string,
  proto_error_code?: string,
  dh_inner_valid?: boolean,
  close_1000_sent?: boolean,
  result?: string,
  source_ref: string,
  deploy_ref: string,
  run_ref: string,
  dhReplyNoncesMatch?: boolean,
  dhReplyFailHash?: Uint8Array,
  innerParseFailed?: boolean
};

type HarnessAuthorizer = {
  log: ((...values: unknown[]) => void) & {
    error: (...values: unknown[]) => void,
    debug: (...values: unknown[]) => void
  },
  sendReqPQ: (auth: Record<string, unknown>) => Promise<unknown>,
  sendSetClientDhParams: (auth: Record<string, unknown>) => Promise<unknown>
};

type RuntimeConnectionListener = (data?: ArrayBuffer) => void;

type HarnessConnectionConstructable = new(dcId: number, endpoint: string, logSuffix: string) => {
  addEventListener: (type: string, listener: RuntimeConnectionListener) => void,
  removeEventListener: (type: string, listener: RuntimeConnectionListener) => void,
  send: (data: Uint8Array) => void,
  close: () => void
};

type HarnessOptions = {
  createConnection?: (input: DiagnosticInput, metrics: AttemptMetrics) => HarnessConnectionConstructable,
  deadlineMs?: number
};

const quietLogger = Object.assign(() => {}, {
  error: () => {},
  debug: () => {}
});

function classifyUpgrade(status?: number) {
  if(status === 101) return '101';
  if(status === 403) return '403';
  if(status === 0 || status === undefined) return 'network_error';
  if(status >= 400 && status < 500) return 'other_4xx';
  if(status >= 500 && status < 600) return '5xx';
  return 'network_error';
}

function normalizeProtocolCode(value: unknown) {
  return value === 404 || value === 429 || value === 444 ? String(value) : 'other';
}

function validOrigin(value: string) {
  try {
    const origin = new URL(value);
    return origin.protocol === 'https:' && origin.origin === value && !origin.username && !origin.password;
  } catch{
    return false;
  }
}

function validateInput(input: DiagnosticInput): ValidatedDiagnosticInput | undefined {
  if(!input || typeof input !== 'object') return undefined;
  if(input.subprotocol !== 'binary' || !Number.isInteger(input.dc_id) || input.dc_id < 1 || input.dc_id > 5) {
    return undefined;
  }
  if(typeof input.origin !== 'string' || !validOrigin(input.origin)) return undefined;
  if(![input.source_ref, input.deploy_ref, input.run_ref].every((value) =>
    typeof value === 'string' && SAFE_REFERENCE_PATTERN.test(value)
  )) return undefined;

  try {
    const target = validateMtprotoTarget(input.target);
    if(target.mode !== 'private') return undefined;
    return {...input, target};
  } catch{
    return undefined;
  }
}

function createLiveTransport(
  input: ValidatedDiagnosticInput,
  metrics: AttemptMetrics,
  createConnection?: HarnessOptions['createConnection']
): AttemptTransport {
  const Connection = (createConnection ? createConnection(input, metrics) : class RuntimeConnection extends NodeWebSocketConnection {
    constructor(dcId: number, endpoint: string, logSuffix: string) {
      super(dcId, endpoint, logSuffix, input.origin, input.subprotocol, metrics);
    }
  }) as unknown as MTConnectionConstructable;

  const transport = new TcpObfuscated(Connection, input.dc_id, input.target.endpoint, '-L1', ATTEMPT_DEADLINE_MS);
  transport.setAutoReconnect(false);
  (transport as unknown as {log: typeof quietLogger}).log = quietLogger;

  return {
    send: transport.send.bind(transport),
    destroy: () => transport.destroy(),
    get upgradeStatus() {
      return metrics.upgradeStatus;
    },
    get close1000Sent() {
      return metrics.close1000Sent;
    }
  };
}

function setErrorResult(observed: ObservedResult, error: unknown, metrics: AttemptMetrics, sentCount: number) {
  if(metrics.networkError) {
    observed.result = 'unknown';
    return;
  }
  if(observed.respq === 'proto_error') {
    observed.result = 'respq_protocol_error';
    return;
  }
  if(observed.dh_reply === 'proto_error') {
    observed.result = 'dh_protocol_error';
    return;
  }

  const originalError = error && typeof error === 'object' ? (error as {originalError?: unknown}).originalError : undefined;
  const code = typeof error === 'number' ? error : typeof originalError === 'number' ? originalError : undefined;
  if(code !== undefined) {
    observed.proto_error_code = normalizeProtocolCode(code);
    if(sentCount === 1) {
      observed.respq = 'proto_error';
      observed.result = 'respq_protocol_error';
    } else if(sentCount === 2) {
      observed.dh_reply = 'proto_error';
      observed.result = 'dh_protocol_error';
    }
    return;
  }

  if(observed.respq_nonce_match === false) {
    observed.result = 'respq_nonce_mismatch';
    return;
  }
  if(observed.pq_valid === false) {
    observed.result = 'pq_invalid';
    return;
  }
  if(observed.fingerprint_in_pinned_set === false) {
    observed.result = 'fingerprint_mismatch';
    return;
  }
  if(observed.dhReplyNoncesMatch === false) {
    observed.result = 'dh_reply_nonce_mismatch';
    return;
  }
  if(observed.dh_reply === 'fail') {
    observed.result = 'dh_reply_refused';
    return;
  }
  if(observed.innerParseFailed) {
    observed.result = 'dh_inner_malformed';
    return;
  }
  if(observed.dh_inner_valid === false) {
    observed.result = 'dh_inner_invalid';
    return;
  }
  if(observed.respq === 'malformed') {
    observed.result = 'respq_malformed';
    return;
  }
  if(observed.dh_reply === 'malformed') {
    observed.result = 'dh_reply_malformed';
    return;
  }
  if(sentCount === 1 && metrics.peerClosed) {
    observed.respq = 'closed';
    observed.result = 'respq_closed';
    return;
  }
  if(sentCount === 2 && metrics.peerClosed) {
    observed.dh_reply = 'closed';
    observed.result = 'dh_reply_closed';
    return;
  }
  if(metrics.malformed) {
    if(sentCount === 1) {
      observed.respq = 'malformed';
      observed.result = 'respq_malformed';
    } else if(sentCount === 2) {
      observed.dh_reply = 'malformed';
      observed.result = 'dh_reply_malformed';
    }
    return;
  }

  const upgrade = classifyUpgrade(metrics.upgradeStatus);
  if(upgrade === '403') observed.result = 'origin_rejected';
  else if(upgrade === 'other_4xx') observed.result = 'upgrade_refused';
  else if(upgrade === '5xx') observed.result = 'server_error';
  else observed.result = 'unknown';
}

function configurePinnedKey(target: Extract<MtprotoTarget, {mode: 'private'}>) {
  const manager = rsaKeysManager as unknown as Record<string, unknown>;
  const ownLoadPublicKeys = Object.prototype.hasOwnProperty.call(manager, 'loadPublicKeys');
  const saved = {
    target: manager.target,
    publicKeysHex: manager.publicKeysHex,
    publicKeysParsed: manager.publicKeysParsed,
    prepared: manager.prepared,
    preparePromise: manager.preparePromise,
    loadPublicKeys: manager.loadPublicKeys
  };

  manager.target = target;
  manager.publicKeysHex = undefined;
  manager.publicKeysParsed = {};
  manager.prepared = false;
  manager.preparePromise = null;
  manager.loadPublicKeys = async() => [target.publicKeyHex];

  return () => {
    manager.target = saved.target;
    manager.publicKeysHex = saved.publicKeysHex;
    manager.publicKeysParsed = saved.publicKeysParsed;
    manager.prepared = saved.prepared;
    manager.preparePromise = saved.preparePromise;
    if(ownLoadPublicKeys) manager.loadPublicKeys = saved.loadPublicKeys;
    else delete manager.loadPublicKeys;
  };
}

function registerServerDhParamsFailForHarness() {
  const constructors = Schema.MTProto.constructors;
  if(constructors.some(({predicate}) => predicate === SERVER_DH_PARAMS_FAIL.predicate)) return () => {};

  const originalIndex = Schema.MTProto.constructorsIndex;
  constructors.push(SERVER_DH_PARAMS_FAIL);
  delete Schema.MTProto.constructorsIndex;

  return () => {
    constructors.pop();
    Schema.MTProto.constructorsIndex = originalIndex;
  };
}

function silenceConsole() {
  const saved = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug
  };
  console.log = console.warn = console.error = console.info = console.debug = () => {};

  return () => {
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
    console.info = saved.info;
    console.debug = saved.debug;
  };
}

export async function runDiagnosticAttempt(input: DiagnosticInput, options: HarnessOptions = {}) {
  const validated = validateInput(input);
  if(!validated) {
    return serializeDiagnosticResult({
      result: 'invalid_input',
      source_ref: input?.source_ref,
      deploy_ref: input?.deploy_ref,
      run_ref: input?.run_ref
    });
  }

  const metrics: AttemptMetrics = {
    requestCount: 0,
    close1000Sent: false,
    peerClosed: false,
    networkError: false,
    malformed: false
  };
  const observed: ObservedResult = {
    source_ref: validated.source_ref,
    deploy_ref: validated.deploy_ref,
    run_ref: validated.run_ref
  };
  const restoreConsole = silenceConsole();
  const restoreDhParamsFailSchema = registerServerDhParamsFailForHarness();
  let transport: AttemptTransport;
  try {
    transport = createLiveTransport(validated, metrics, options.createConnection);
  } catch{
    restoreDhParamsFailSchema();
    restoreConsole();
    return serializeDiagnosticResult({...observed, result: 'unknown'});
  }
  const originalTransportSend = transport.send.bind(transport);
  let sendCallCount = 0;
  transport.send = (data) => {
    if(++sendCallCount > 2) throw new Error('prekey_request_limit');
    return originalTransportSend(data);
  };

  const restorePinnedKey = configurePinnedKey(validated.target as Extract<MtprotoTarget, {mode: 'private'}>);
  const originalFetchObject = TLDeserialization.prototype.fetchObject;
  const originalConsume = AbridgedPacketStream.prototype.consume;
  const manager = rsaKeysManager as unknown as {
    select: (fingerprints: string[]) => Promise<unknown>
  };
  const originalSelect = manager.select;
  const cryptoWorker = CryptoWorker as unknown as {
    invokeCrypto: (method: string, ...args: unknown[]) => Promise<unknown>
  };
  const cryptoWorkerRecord = cryptoWorker as unknown as Record<string, unknown>;
  const hadOwnCryptoInvoke = Object.prototype.hasOwnProperty.call(cryptoWorkerRecord, 'invokeCrypto');
  const originalCryptoInvoke = cryptoWorker.invokeCrypto;
  const callOriginalCrypto = originalCryptoInvoke.bind(CryptoWorker);
  let authNonce: Uint8Array;
  let deadlineId: ReturnType<typeof setTimeout> | undefined;
  const authorizer = new Authorizer({timeManager: new TimeManager(), dcConfigurator: {} as never}) as unknown as HarnessAuthorizer;
  authorizer.log = quietLogger;
  authorizer.sendSetClientDhParams = async() => {
    observed.dh_inner_valid = true;
    throw PREKEY_BOUNDARY;
  };

  (TLDeserialization.prototype as unknown as {fetchObject: (type: string, field?: string) => unknown}).fetchObject = function(this: any, type, field) {
    let value: any;
    try {
      value = originalFetchObject.call(this, type, field);
    } catch(error) {
      if(type === 'ResPQ') observed.respq = 'malformed';
      if(type === 'Server_DH_Params') observed.dh_reply = 'malformed';
      if(type === 'Server_DH_inner_data') observed.innerParseFailed = true;
      throw error;
    }

    if(type === 'ResPQ') {
      if(value?._ === 'rpc_error') {
        observed.respq = 'proto_error';
        observed.proto_error_code = normalizeProtocolCode(value.error_code);
      } else if(value?._ !== 'resPQ') {
        observed.respq = 'malformed';
      } else {
        observed.respq = 'complete';
        observed.respq_nonce_match = bytesCmp(authNonce, value.nonce);
      }
    } else if(type === 'Server_DH_Params') {
      if(value?._ === 'server_DH_params_ok') observed.dh_reply = 'ok';
      else if(value?._ === 'server_DH_params_fail') observed.dh_reply = 'malformed';
      else if(value?._ === 'rpc_error') {
        observed.dh_reply = 'proto_error';
        observed.proto_error_code = normalizeProtocolCode(value.error_code);
      }
      else observed.dh_reply = 'malformed';
      observed.dhReplyNoncesMatch = bytesCmp(authNonce, value?.nonce) &&
        bytesCmp((activeAuth as Record<string, any>).serverNonce, value?.server_nonce);
      if(value?._ === 'server_DH_params_fail' && value.new_nonce_hash instanceof Uint8Array) {
        observed.dhReplyFailHash = value.new_nonce_hash;
      }
    } else if(type === 'Server_DH_inner_data') {
      if(value?._ === 'server_DH_inner_data') observed.dh_inner_valid = false;
      else observed.innerParseFailed = true;
    }

    return value;
  } as typeof TLDeserialization.prototype.fetchObject;

  (AbridgedPacketStream.prototype as unknown as {consume: typeof originalConsume}).consume = async function(...args) {
    try {
      return await originalConsume.apply(this, args);
    } catch(error) {
      metrics.malformed = true;
      throw error;
    }
  };

  manager.select = async(fingerprints) => {
    if(observed.respq_nonce_match === true) observed.pq_valid = true;
    const selected = await originalSelect.call(rsaKeysManager, fingerprints);
    if(observed.respq_nonce_match === true) observed.fingerprint_in_pinned_set = Boolean(selected);
    return selected;
  };

  cryptoWorker.invokeCrypto = async(method, ...args) => {
    try {
      const result = await callOriginalCrypto(method, ...args);
      if(method === 'sha1' && observed.dhReplyFailHash && result instanceof Uint8Array) {
        observed.dh_reply = bytesCmp(observed.dhReplyFailHash, result.slice(-16)) ? 'fail' : 'malformed';
        observed.dhReplyFailHash = undefined;
      }
      return result;
    } catch(error) {
      if(method === 'sha1' && observed.dhReplyFailHash) {
        observed.dh_reply = 'malformed';
        observed.dhReplyFailHash = undefined;
      }
      throw error;
    }
  };

  const deadlineMs = options.deadlineMs ?? ATTEMPT_DEADLINE_MS;
  let activeAuth: Record<string, any>;
  const sendAttempt = async() => {
    authNonce = randomBytes(16);
    activeAuth = {
      dcId: validated.dc_id,
      nonce: authNonce,
      temp: false,
      media: false,
      transport
    };
    return authorizer.sendReqPQ(activeAuth);
  };
  const attemptResult = sendAttempt().then(
    () => ({kind: 'complete' as const}),
    (error) => ({kind: 'error' as const, error})
  );
  const deadlineResult = new Promise<{kind: 'deadline'}>((resolve) => {
    deadlineId = setTimeout(() => resolve({kind: 'deadline'}), deadlineMs);
  });

  try {
    const outcome = await Promise.race([attemptResult, deadlineResult]);
    observed.upgrade = classifyUpgrade(transport.upgradeStatus ?? metrics.upgradeStatus);

    if(outcome.kind === 'deadline') {
      if(metrics.requestCount === 1 && !observed.respq) observed.respq = 'timeout';
      if(metrics.requestCount === 2 && !observed.dh_reply) observed.dh_reply = 'timeout';
      observed.result = 'unknown';
    } else if(outcome.kind === 'error') {
      if(outcome.error === PREKEY_BOUNDARY) {
        observed.result = 'dh_inner_valid';
      } else if(observed.respq === 'complete' && observed.respq_nonce_match === true && observed.pq_valid === undefined) {
        observed.pq_valid = false;
        setErrorResult(observed, outcome.error, metrics, metrics.requestCount);
      } else {
        if(observed.innerParseFailed) observed.dh_inner_valid = undefined;
        setErrorResult(observed, outcome.error, metrics, metrics.requestCount);
      }
    } else if(observed.dh_inner_valid === true) {
      observed.result = 'dh_inner_valid';
    } else {
      observed.result = 'unknown';
    }
  } catch{
    observed.upgrade = classifyUpgrade(transport.upgradeStatus ?? metrics.upgradeStatus);
    observed.result = 'unknown';
  } finally {
    if(deadlineId !== undefined) clearTimeout(deadlineId);
    try {
      transport.destroy();
    } catch{
      // Cleanup errors must not become a diagnostic string.
    }
    observed.close_1000_sent = transport.close1000Sent ?? metrics.close1000Sent;
    if(observed.upgrade === undefined) observed.upgrade = classifyUpgrade(transport.upgradeStatus ?? metrics.upgradeStatus);

    (TLDeserialization.prototype as unknown as {fetchObject: typeof originalFetchObject}).fetchObject = originalFetchObject;
    (AbridgedPacketStream.prototype as unknown as {consume: typeof originalConsume}).consume = originalConsume;
    manager.select = originalSelect;
    if(hadOwnCryptoInvoke) cryptoWorker.invokeCrypto = originalCryptoInvoke;
    else delete cryptoWorkerRecord.invokeCrypto;
    observed.dhReplyFailHash = undefined;
    restorePinnedKey();
    restoreDhParamsFailSchema();
    restoreConsole();
  }

  return serializeDiagnosticResult(observed);
}
