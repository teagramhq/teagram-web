import {describe, expect, it} from 'vitest';
import {TLSerialization} from '@lib/mtproto/tl_utils';

describe('Turnstile signup serialization', () => {
  it('serializes a method-tagged !X query as its nested API method', () => {
    const signupParams = {
      phone_number: '+15555550123',
      phone_code_hash: 'signup-code-hash',
      first_name: 'Teagram',
      last_name: 'User'
    };
    const expected = new TLSerialization();
    expected.storeMethod('invokeWithReCaptcha', {
      token: 'turnstile-token',
      query: (serialization: TLSerialization) => serialization.storeMethod('auth.signUp', signupParams)
    });

    const actual = new TLSerialization();
    actual.storeMethod('invokeWithReCaptcha', {
      token: 'turnstile-token',
      query: {_: 'auth.signUp', ...signupParams}
    });

    expect(actual.getBytes(true)).toEqual(expected.getBytes(true));
  });
});
