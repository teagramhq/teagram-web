import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {rewritePrivateWorkerImports} from '@helpers/createPrivateWorkerBlobURL';

const PRIVATE_ENDPOINT = 'wss://private.example.test:2443/apiws';
const privateTarget = {
  mode: 'private' as const,
  endpoint: PRIVATE_ENDPOINT,
  fingerprint: 'c94b4d28b2d215b8',
  publicKey: '-----BEGIN RSA PUBLIC KEY-----\nAA==\n-----END RSA PUBLIC KEY-----',
  publicKeyHex: {
    modulus: 'a'.repeat(512),
    exponent: '010001'
  },
  routeLock: {
    mode: 'private' as const,
    endpoint: PRIVATE_ENDPOINT,
    transport: 'websocket' as const,
    dcIds: [1, 2, 3, 4, 5] as const,
    connectionTypes: ['client', 'upload', 'download'] as const
  }
};

class FakeWebSocket extends EventTarget {
  public static urls: string[] = [];
  public binaryType = 'arraybuffer';

  constructor(public url: string, _protocol: string) {
    super();
    FakeWebSocket.urls.push(url);
  }

  public send(_body: ArrayBufferView) {}
  public close() {}
}

type Socket = typeof import('@lib/mtproto/transports/websocket').default;
let PrivateSocket: Socket;

describe('private MTProto browser egress policy', () => {
  beforeAll(async() => {
    vi.doMock('@config/mtprotoTarget', () => ({
      MTProtoTarget: privateTarget,
      getMtprotoTarget: () => privateTarget,
      isPrivateMtprotoTarget: () => true,
      validateMtprotoTarget: (target: unknown) => target
    }));
    ({default: PrivateSocket} = await import('@lib/mtproto/transports/websocket'));
  });

  afterAll(() => {
    vi.doUnmock('@config/mtprotoTarget');
    vi.resetModules();
  });

  it('rewrites minified static imports to same-origin worker URLs', () => {
    const source = [
      'import{worker}from"./chunk.js";',
      'import"./side-effect.js";',
      'export{worker}from"../re-export.js";',
      'import root from"/root.js";',
      'import("./quoted.js")',
      'import(' + String.fromCharCode(96) + './template.js' + String.fromCharCode(96) + ')'
    ].join('\n');
    const rewritten = rewritePrivateWorkerImports(source, 'https://web.telegram.org/k/');

    expect(rewritten).toContain('from"https://web.telegram.org/k/chunk.js"');
    expect(rewritten).toContain('import"https://web.telegram.org/k/side-effect.js"');
    expect(rewritten).toContain('from"https://web.telegram.org/re-export.js"');
    expect(rewritten).toContain('from"https://web.telegram.org/k/root.js"');
    expect(rewritten).toContain('import("https://web.telegram.org/k/quoted.js")');
    expect(rewritten).toContain('import(' + String.fromCharCode(96) + 'https://web.telegram.org/k/template.js' + String.fromCharCode(96) + ')');
    expect(rewritten).not.toMatch(/(?:\bfrom\s*|\bimport\s*)(["'])(\.{1,2}\/[^"']+)\1/);
    expect(rewritten).not.toMatch(/import\s*\(\s*(["'\x60])(\.{1,2}\/[^"'\x60]+)\1\s*\)/);
  });

  it('allows the configured WSS endpoint and blocks an unconfigured origin at the browser dial boundary', () => {
    FakeWebSocket.urls = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const allowed = new PrivateSocket(1, PRIVATE_ENDPOINT, '');
    expect(FakeWebSocket.urls).toEqual([PRIVATE_ENDPOINT]);
    allowed.close();

    expect(() => new PrivateSocket(1, 'wss://unconfigured.example.test/apiws', '')).toThrow(/private.*endpoint/i);
    expect(FakeWebSocket.urls).toEqual([PRIVATE_ENDPOINT]);
  });
});
