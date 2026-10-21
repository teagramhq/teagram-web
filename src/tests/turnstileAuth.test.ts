import {describe, expect, it, vi} from 'vitest';

import {getTurnstileSiteKey, invokeTurnstileProtected} from '@/pages/turnstileSignup';

describe('Turnstile auth challenge', () => {
  it('accepts signin and signup challenges only for their matching action', () => {
    expect(getTurnstileSiteKey({type: 'RECAPTCHA_CHECK_signin__signin-key'}, 'signin')).toBe('signin-key');
    expect(getTurnstileSiteKey({type: 'RECAPTCHA_CHECK_signup__signup-key'}, 'signup')).toBe('signup-key');
    expect(getTurnstileSiteKey({type: 'RECAPTCHA_CHECK_signup__signup-key'}, 'signin')).toBeUndefined();
  });

  it('does not infer signin enforcement from the advertised signup key', async() => {
    const response = {_: 'auth.sentCode'};
    const invokeApi = vi.fn().mockResolvedValue(response);
    const requestChallenge = vi.fn((_siteKey, _action, submit) => submit('fresh-signin-token'));
    const params = {phone_number: 'Alice_123'} as any;

    await expect(invokeTurnstileProtected(
      invokeApi,
      'auth.sendCode',
      params,
      'signin',
      requestChallenge,
      'signup-only-site-key'
    )).resolves.toEqual(response);

    expect(invokeApi).toHaveBeenCalledOnce();
    expect(invokeApi).toHaveBeenCalledWith('auth.sendCode', params);
    expect(requestChallenge).not.toHaveBeenCalled();
  });

  it('keeps checkPassword error-driven when only a signup key is advertised', async() => {
    const response = {_: 'auth.authorization'};
    const invokeApi = vi.fn().mockResolvedValue(response);
    const requestChallenge = vi.fn((_siteKey, _action, submit) => submit('fresh-signin-token'));
    const params = {password: {_ : 'inputCheckPasswordSRP', srp_id: '1', A: new Uint8Array([1]), M1: new Uint8Array([2])}} as const;

    await expect(invokeTurnstileProtected(
      invokeApi,
      'auth.checkPassword',
      params,
      'signin',
      requestChallenge,
      'signup-only-site-key'
    )).resolves.toEqual(response);

    expect(invokeApi).toHaveBeenCalledOnce();
    expect(invokeApi).toHaveBeenCalledWith('auth.checkPassword', params);
    expect(requestChallenge).not.toHaveBeenCalled();
  });

  it('keeps advertised-key protection for signup', async() => {
    const response = {_: 'auth.authorization'};
    const invokeApi = vi.fn().mockResolvedValue(response);
    const requestChallenge = vi.fn((_siteKey, _action, submit) => submit('fresh-signup-token'));
    const params = {phone_number: 'Alice_123', first_name: 'Teagram'} as any;

    await expect(invokeTurnstileProtected(
      invokeApi,
      'auth.signUp',
      params,
      'signup',
      requestChallenge,
      'signup-site-key'
    )).resolves.toEqual(response);

    expect(requestChallenge).toHaveBeenCalledOnce();
    expect(invokeApi).toHaveBeenCalledWith('invokeWithReCaptcha', {
      token: 'fresh-signup-token',
      query: {_: 'auth.signUp', ...params}
    });
  });

  it('retries auth.checkPassword with a signin token', async() => {
    const invokeApi = vi.fn()
    .mockRejectedValueOnce({type: 'RECAPTCHA_CHECK_signin__test-site-key'})
    .mockResolvedValueOnce({_: 'auth.authorization'});
    const requestChallenge = vi.fn((siteKey, action, submit) => {
      expect(siteKey).toBe('test-site-key');
      expect(action).toBe('signin');
      return submit('signin-token');
    });
    const params = {password: {_ : 'inputCheckPasswordSRP', srp_id: '1', A: new Uint8Array([1]), M1: new Uint8Array([2])}} as const;

    await expect(invokeTurnstileProtected(invokeApi, 'auth.checkPassword', params, 'signin', requestChallenge))
    .resolves.toEqual({_: 'auth.authorization'});

    expect(invokeApi).toHaveBeenNthCalledWith(1, 'auth.checkPassword', params);
    expect(invokeApi).toHaveBeenNthCalledWith(2, 'invokeWithReCaptcha', {
      token: 'signin-token',
      query: {_: 'auth.checkPassword', ...params}
    });
  });

  it('allows a fresh-token attempt after a downstream signin failure', async() => {
    const invokeApi = vi.fn()
    .mockRejectedValueOnce({type: 'RECAPTCHA_CHECK_signin__test-site-key'})
    .mockRejectedValueOnce({type: 'PASSWORD_HASH_INVALID'})
    .mockRejectedValueOnce({type: 'RECAPTCHA_CHECK_signin__test-site-key'})
    .mockResolvedValueOnce({_: 'auth.authorization'});
    const tokens = ['first-signin-token', 'second-signin-token'];
    const requestChallenge = vi.fn((_siteKey, _action, submit) => submit(tokens.shift()!));
    const params = {password: {_ : 'inputCheckPasswordSRP', srp_id: '1', A: new Uint8Array([1]), M1: new Uint8Array([2])}} as const;

    await expect(invokeTurnstileProtected(invokeApi, 'auth.checkPassword', params, 'signin', requestChallenge))
    .rejects.toMatchObject({type: 'PASSWORD_HASH_INVALID'});
    expect(invokeApi).toHaveBeenCalledTimes(2);

    await expect(invokeTurnstileProtected(invokeApi, 'auth.checkPassword', params, 'signin', requestChallenge))
    .resolves.toEqual({_: 'auth.authorization'});

    expect(requestChallenge).toHaveBeenCalledTimes(2);
    expect(invokeApi).toHaveBeenNthCalledWith(2, 'invokeWithReCaptcha', {
      token: 'first-signin-token',
      query: {_: 'auth.checkPassword', ...params}
    });
    expect(invokeApi).toHaveBeenNthCalledWith(4, 'invokeWithReCaptcha', {
      token: 'second-signin-token',
      query: {_: 'auth.checkPassword', ...params}
    });
  });
});
