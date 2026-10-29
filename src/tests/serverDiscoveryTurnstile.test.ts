import {describe, expect, it, vi} from 'vitest';

import {fetchEmbeddedServerDiscovery, validateDiscoveryDocument} from '@config/serverSelection';

describe('Turnstile server discovery', () => {
  it('returns the public widget key from a validated discovery document', async() => {
    const pair = await crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    }, true, ['encrypt', 'decrypt']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const rsaSpki = btoa(String.fromCharCode(...spki));

    const discovered = await validateDiscoveryDocument('custom.example', {
      version: 1,
      mtproto: {endpoint: 'custom.example:443', dc_id: 2, rsa_spki: rsaSpki},
      websocket: {endpoint: 'wss://custom.example/apiws'},
      turnstile: {site_key: 'public-site-key'}
    });

    expect(discovered.turnstileSiteKey).toBe('public-site-key');
  });

  it('rejects malformed public widget keys', async() => {
    await expect(validateDiscoveryDocument('custom.example', {
      version: 1,
      mtproto: {},
      websocket: {},
      turnstile: {site_key: 'invalid key'}
    })).rejects.toThrow('invalid Turnstile site key');
  });

  it('enables guest sign-up only for a literal true discovery flag', async() => {
    const pair = await crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    }, true, ['encrypt', 'decrypt']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const rsaSpki = btoa(String.fromCharCode(...spki));
    const flags: Array<[unknown, boolean]> = [[true, true], [undefined, false], [false, false], ['true', false], [1, false]];

    for(const [guestSignUp, expected] of flags) {
      const discovered = await validateDiscoveryDocument('custom.example', {
        version: 1,
        mtproto: {endpoint: 'custom.example:443', dc_id: 2, rsa_spki: rsaSpki},
        websocket: {endpoint: 'wss://custom.example/apiws'},
        demo: {guest_sign_up: guestSignUp}
      });
      expect(discovered.guestSignUpEnabled).toBe(expected);
    }
  });

  it('loads embedded private-server capabilities only from the pinned server identity', async() => {
    const pair = await crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    }, true, ['encrypt', 'decrypt']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const rsaSpki = btoa(String.fromCharCode(...spki));
    const document = {
      version: 1,
      mtproto: {endpoint: 'custom.example:443', dc_id: 2, rsa_spki: rsaSpki},
      websocket: {endpoint: 'wss://custom.example/apiws'},
      demo: {guest_sign_up: true}
    };
    const embedded = await validateDiscoveryDocument('custom.example', document);
    const fetcher = vi.fn(async() => new Response(JSON.stringify(document)));

    await expect(fetchEmbeddedServerDiscovery(embedded.target, fetcher as typeof fetch))
    .resolves.toMatchObject({guestSignUpEnabled: true, target: {endpoint: 'wss://custom.example/apiws'}});
    expect(fetcher).toHaveBeenCalledWith(
      'https://custom.example/.well-known/teagramd/client',
      expect.objectContaining({credentials: 'omit', redirect: 'error'})
    );

    const alternateEndpoint = {
      ...document,
      websocket: {endpoint: 'wss://custom.example/other'}
    };
    await expect(fetchEmbeddedServerDiscovery(embedded.target, async() => new Response(JSON.stringify(alternateEndpoint))))
    .rejects.toThrow(/does not match the embedded private target/i);

    const otherPair = await crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    }, true, ['encrypt', 'decrypt']);
    const otherSpki = new Uint8Array(await crypto.subtle.exportKey('spki', otherPair.publicKey));
    const alternateKey = {
      ...document,
      mtproto: {...document.mtproto, rsa_spki: btoa(String.fromCharCode(...otherSpki))}
    };
    await expect(fetchEmbeddedServerDiscovery(embedded.target, async() => new Response(JSON.stringify(alternateKey))))
    .rejects.toThrow(/does not match the embedded private target/i);
  });
});
