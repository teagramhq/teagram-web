import {createCipheriv} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import '@lib/crypto/crypto.worker';
import {Authorizer} from '@lib/mtproto/authorizer';
import Socket from '@lib/mtproto/transports/websocket';
import TcpObfuscated from '@lib/mtproto/transports/tcpObfuscated';
import {TimeManager} from '@lib/mtproto/timeManager';

const ENDPOINT = 'wss://synthetic.example.test/apiws';
const NONCE = new Uint8Array(16).fill(1);
const SERVER_NONCE = new Uint8Array(16).fill(2);
const transports: TcpObfuscated[] = [];

function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for(const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function encodeTlBytes(bytes: Uint8Array) {
  const header = new Uint8Array([254, bytes.length & 0xff, bytes.length >> 8, 0]);
  const padding = new Uint8Array((4 - (header.length + bytes.length) % 4) % 4);
  return concat(header, bytes, padding);
}

function serializeDhReply(encryptedAnswerLength: number) {
  const encryptedAnswer = Uint8Array.from({length: encryptedAnswerLength}, (_, index) => index & 0xff);
  const body = concat(
    new Uint8Array([0x5c, 0x07, 0xe8, 0xd0]),
    NONCE,
    SERVER_NONCE,
    encodeTlBytes(encryptedAnswer)
  );
  const bodyLength = new Uint8Array(4);
  new DataView(bodyLength.buffer).setUint32(0, body.length, true);
  const message = concat(
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0]),
    bodyLength,
    body
  );

  return {encryptedAnswer, message};
}

class SyntheticWebSocket extends EventTarget {
  public static responseFrame: Uint8Array;
  public binaryType: BinaryType = 'arraybuffer';
  private initPayload: Uint8Array;
  private requestCount = 0;

  constructor(_url: string, _protocol: string) {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  public send(body: ArrayBufferView) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if(!this.initPayload) {
      this.initPayload = bytes.slice();
      return;
    }

    if(++this.requestCount !== 1) return;

    const reversedInitPayload = this.initPayload.slice().reverse();
    const cipher = createCipheriv(
      'aes-256-ctr',
      reversedInitPayload.subarray(8, 40),
      reversedInitPayload.subarray(40, 56)
    );
    const encrypted = cipher.update(SyntheticWebSocket.responseFrame);
    const response = encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength);

    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: response})));
  }

  public close() {
    this.dispatchEvent(new Event('close'));
  }
}

type AuthorizerTestSurface = {
  sendReqDhParams: (auth: Record<string, unknown>) => Promise<unknown>,
  decryptServerDhDataAnswer: (auth: Record<string, unknown>, encryptedAnswer: Uint8Array) => Promise<void>,
  sendSetClientDhParams: (auth: Record<string, unknown>) => Promise<unknown>
};

describe('authorizer long server_DH_params reply over the Web transport', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', SyntheticWebSocket);
  });

  afterEach(() => {
    for(const transport of transports.splice(0)) transport.destroy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['short', 256, 316, [0x4f]],
    ['long', 512, 572, [0x7f, 0x8f, 0, 0]]
  ])('recognizes a %s reply and enters decrypt with its encrypted_answer', async(_name, encryptedAnswerLength, expectedMessageLength, expectedHeader) => {
    const {encryptedAnswer, message} = serializeDhReply(encryptedAnswerLength);
    const header = Uint8Array.from(expectedHeader);
    SyntheticWebSocket.responseFrame = concat(header, message);

    const transport = new TcpObfuscated(Socket, 1, ENDPOINT, '', 3000);
    transports.push(transport);
    transport.setAutoReconnect(false);

    const authorizer = new Authorizer({
      timeManager: new TimeManager(),
      dcConfigurator: {} as never
    });
    const internals = authorizer as unknown as AuthorizerTestSurface;
    const auth = {
      dcId: 1,
      nonce: NONCE,
      serverNonce: SERVER_NONCE,
      temp: false,
      media: false,
      pq: new Uint8Array([0x17, 0x11]),
      p: new Uint8Array([3]),
      q: new Uint8Array([5]),
      publicKey: {
        modulus: 'f'.repeat(512),
        exponent: '010001',
        fingerprint: '0102030405060708'
      },
      transport
    };

    // The pre-auth response is tied to the exchange by nonce checks in Authorizer;
    // encrypted_answer integrity and DH parameter validation happen in this helper.
    // Stub that boundary only to isolate Web framing and constructor dispatch; this
    // fixture does not cover those cryptographic checks.
    const decryptEntry = vi.spyOn(internals, 'decryptServerDhDataAnswer').mockResolvedValue();
    vi.spyOn(internals, 'sendSetClientDhParams').mockResolvedValue(auth);

    await expect(internals.sendReqDhParams(auth)).resolves.toBe(auth);

    expect(decryptEntry).toHaveBeenCalledWith(auth, encryptedAnswer);
    expect(message.byteLength).toBe(expectedMessageLength);
    expect(Array.from(SyntheticWebSocket.responseFrame.subarray(0, header.length))).toEqual(expectedHeader);
  });
});
