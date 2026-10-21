import {describe, expect, it} from 'vitest';
import {TLSerialization} from '@lib/mtproto/tl_utils';

describe('Turnstile auth serialization', () => {
  it.each([
    ['auth.sendCode', {
      phone_number: '+15555550123',
      api_id: 123,
      api_hash: 'api-hash',
      settings: {_ : 'codeSettings', pFlags: {}}
    }],
    ['auth.checkPassword', {
      password: {_ : 'inputCheckPasswordSRP', srp_id: '1', A: new Uint8Array([1]), M1: new Uint8Array([2])}
    }],
    ['auth.signUp', {
      phone_number: '+15555550123',
      phone_code_hash: 'signup-code-hash',
      first_name: 'Teagram',
      last_name: 'User'
    }]
  ] as const)('serializes %s as the nested API method', (method, params) => {
    const expected = new TLSerialization();
    expected.storeMethod('invokeWithReCaptcha', {
      token: 'turnstile-token',
      query: (serialization: TLSerialization) => serialization.storeMethod(method, params)
    });

    const actual = new TLSerialization();
    actual.storeMethod('invokeWithReCaptcha', {
      token: 'turnstile-token',
      query: {_: method, ...params}
    });

    expect(actual.getBytes(true)).toEqual(expected.getBytes(true));
  });
});
