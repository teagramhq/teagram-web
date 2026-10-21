import {describe, expect, it} from 'vitest';

import {validateDiscoveryDocument} from '@config/serverSelection';

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
});
