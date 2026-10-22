import {beforeAll, describe, expect, it, vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {
  DISCOVERY_MAX_BYTES,
  DISCOVERY_TIMEOUT_MS,
  fetchServerDiscovery,
  getServerConnectSources,
  getServerPinState,
  normalizeServerHost,
  pinMatches,
  shouldPromptForServerSelection,
  validateDiscoveryDocument,
  websocketConnectionFailureMessage
} from '@config/serverSelection';

vi.stubGlobal('crypto', webcrypto);

let document: any;

beforeAll(async() => {
  const pair = await crypto.subtle.generateKey({
    name: 'RSA-OAEP',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  }, true, ['encrypt', 'decrypt']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  document = {
    version: 1,
    mtproto: {
      endpoint: 'demo.example:2443',
      dc_id: 2,
      rsa_spki: btoa(String.fromCharCode(...spki))
    },
    websocket: {endpoint: 'wss://demo.example/apiws'}
  };
});

describe('custom server discovery', () => {
  it('only prompts on the public multi-server origin and narrows connections to the active server', () => {
    expect(shouldPromptForServerSelection('web.teagram.io')).toBe(true);
    expect(shouldPromptForServerSelection('teagram.tailaa4918.ts.net')).toBe(false);
    expect(getServerConnectSources('demo.example', {
      mode: 'private',
      endpoint: 'wss://demo.example:2443/apiws'
    } as any)).toEqual([
      '\u0027self\u0027',
      'https://demo.example',
      'wss://demo.example',
      'wss://demo.example:2443'
    ]);
  });

  it('normalizes hosts to lower-case ASCII and removes a trailing dot', () => {
    expect(normalizeServerHost('BÜCHER.Example.')).toBe('xn--bcher-kva.example');
  });

  it.each([
    'https://demo.example',
    'user@demo.example',
    'demo.example/path',
    'demo.example?x=1',
    'demo.example#fragment',
    'telegram.org',
    'chat.telegram.org'
  ])('rejects an unsafe entered host: %s', (host) => {
    expect(() => normalizeServerHost(host)).toThrow();
  });

  it('validates the version, endpoint host, TLS scheme, and 2048-bit key', async() => {
    await expect(validateDiscoveryDocument('demo.example', document)).resolves.toMatchObject({
      host: 'demo.example',
      pin: {host: 'demo.example', endpoint: 'wss://demo.example/apiws', dc_id: 2}
    });
    await expect(validateDiscoveryDocument('demo.example', {...document, version: 2})).rejects.toThrow(/unsupported/);
    await expect(validateDiscoveryDocument('demo.example', {
      ...document,
      websocket: {endpoint: 'ws://demo.example/apiws'}
    })).rejects.toThrow(/invalid WebSocket endpoint/);
    await expect(validateDiscoveryDocument('demo.example', {
      ...document,
      websocket: {endpoint: 'wss://user@demo.example/apiws'}
    })).rejects.toThrow(/invalid WebSocket endpoint/);
    await expect(validateDiscoveryDocument('demo.example', {
      ...document,
      websocket: {endpoint: 'wss://evil.example/apiws'}
    })).rejects.toThrow(/does not match/);
    await expect(validateDiscoveryDocument('demo.example', {
      ...document,
      websocket: {endpoint: 'wss://telegram.org/apiws'}
    })).rejects.toThrow(/invalid WebSocket endpoint/);
    await expect(validateDiscoveryDocument('telegram.org', document)).rejects.toThrow(/not allowed/);

    const smallPair = await crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    }, true, ['encrypt', 'decrypt']);
    const smallKey = new Uint8Array(await crypto.subtle.exportKey('spki', smallPair.publicKey));
    await expect(validateDiscoveryDocument('demo.example', {
      ...document,
      mtproto: {...document.mtproto, rsa_spki: btoa(String.fromCharCode(...smallKey))}
    })).rejects.toThrow(/RSA-2048/);

    const wrongExponentPair = await crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([3]),
      hash: 'SHA-256'
    }, true, ['encrypt', 'decrypt']);
    const wrongExponentKey = new Uint8Array(await crypto.subtle.exportKey('spki', wrongExponentPair.publicKey));
    await expect(validateDiscoveryDocument('demo.example', {
      ...document,
      mtproto: {...document.mtproto, rsa_spki: btoa(String.fromCharCode(...wrongExponentKey))}
    })).rejects.toThrow(/exponent 65537/);
  });

  it('enables guest sign-up only for the literal discovery boolean true', async() => {
    const values: Array<[Record<string, unknown>, boolean]> = [
      [{demo: {guest_sign_up: true}}, true],
      [{demo: {guest_sign_up: false}}, false],
      [{demo: {guest_sign_up: 'true'}}, false],
      [{demo: {guest_sign_up: 1}}, false],
      [{demo: {guest_sign_up: null}}, false],
      [{demo: {}}, false],
      [{demo: null}, false],
      [{demo: 'guest sign-up'}, false],
      [{}, false]
    ];

    for(const [extra, expected] of values) {
      const discovered = await validateDiscoveryDocument('demo.example', {...document, ...extra});
      expect(discovered.guestSignUpEnabled).toBe(expected);
    }
  });

  it('fetches directly with redirect rejection and no credentials, and bounds response bytes', async() => {
    const fetcher = vi.fn(async(_url: string, _options: RequestInit) => new Response(JSON.stringify(document)));
    await fetchServerDiscovery('demo.example', fetcher as any);
    expect(fetcher).toHaveBeenCalledWith(
      'https://demo.example/.well-known/teagramd/client',
      expect.objectContaining({redirect: 'error', credentials: 'omit'})
    );

    const redirectFetcher = vi.fn(async() => { throw new TypeError('redirect rejected'); });
    await expect(fetchServerDiscovery('demo.example', redirectFetcher as any)).rejects.toThrow('redirect rejected');

    const oversized = new Response(new Uint8Array(DISCOVERY_MAX_BYTES + 1));
    await expect(fetchServerDiscovery('demo.example', vi.fn(async() => oversized) as any)).rejects.toThrow(/too large/);
  });

  it('aborts a stalled discovery request after the timeout', async() => {
    vi.useFakeTimers();
    let aborted = false;
    try {
      const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }));
      const request = fetchServerDiscovery('demo.example', fetcher as any).catch((error) => error);

      await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
      await expect(request).resolves.toMatchObject({name: 'AbortError'});
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses changed pin fields without an override path', async() => {
    const discovered = await validateDiscoveryDocument('demo.example', document);
    expect(getServerPinState(discovered)).toBe('first-use');
    expect(getServerPinState(discovered, discovered.pin)).toBe('match');
    expect(pinMatches(discovered, discovered.pin)).toBe(true);
    const mismatch = {...discovered.pin, key_fingerprint: '0'.repeat(64)};
    expect(pinMatches(discovered, mismatch)).toBe(false);
    expect(getServerPinState(discovered, mismatch)).toBe('mismatch');
    expect(pinMatches(discovered, {...discovered.pin, endpoint: 'wss://demo.example/new'})).toBe(false);
    expect(pinMatches(discovered, {...discovered.pin, dc_id: 3})).toBe(false);
    expect(websocketConnectionFailureMessage('demo.example')).toContain('unreachable or does not allow https://web.teagram.io');
  });
});
