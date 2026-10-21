import {describe, expect, it, vi} from 'vitest';

import {authenticatePrivateUsername, isPrivateUsername, isPrivateUsernameCredentialError} from '@/pages/privateUsernameAuth';

const USERNAME = 'Alice_123';
const SENT_CODE = {
  _: 'auth.sentCode',
  phone_code_hash: 'mock-code-hash',
  type: {_ : 'auth.sentCodeTypeApp', length: 5},
  timeout: 60
};

describe('private username sign-in', () => {
  it('accepts only the server username syntax', () => {
    expect(isPrivateUsername('Alice_123')).toBe(true);
    expect(isPrivateUsername('a1234')).toBe(true);
    expect(isPrivateUsername('1Alice')).toBe(false);
    expect(isPrivateUsername('_Alice1')).toBe(false);
    expect(isPrivateUsername('Abc1')).toBe(false);
    expect(isPrivateUsername('A'.repeat(33))).toBe(false);
    expect(isPrivateUsername('Alice-123')).toBe(false);
  });

  it('rejects malformed input before making an authentication RPC', async() => {
    const invokeApi = vi.fn();

    await expect(authenticatePrivateUsername('ab', invokeApi)).resolves.toEqual({kind: 'invalidInput'});
    expect(invokeApi).not.toHaveBeenCalled();
  });

  it('uses the empty-code username flow and requests the existing password card', async() => {
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'});

    await expect(authenticatePrivateUsername(USERNAME, invokeApi)).resolves.toEqual({kind: 'password'});

    expect(invokeApi).toHaveBeenNthCalledWith(1, 'auth.sendCode', expect.objectContaining({
      phone_number: USERNAME,
      settings: {_ : 'codeSettings', pFlags: {}}
    }));
    expect(invokeApi).toHaveBeenNthCalledWith(2, 'auth.signIn', {
      phone_number: USERNAME,
      phone_code_hash: 'mock-code-hash',
      phone_code: ''
    }, {ignoreErrors: true});
    expect(invokeApi).toHaveBeenCalledTimes(2);
  });

  it('returns authorization without carrying the identifier into the result', async() => {
    const user = {_: 'user', id: 42};
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorization', user});

    await expect(authenticatePrivateUsername(USERNAME, invokeApi)).resolves.toEqual({kind: 'authorized', user});
  });

  it('keeps closed registration as a generic credential failure without a registration RPC', async() => {
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}});

    await expect(authenticatePrivateUsername(USERNAME, invokeApi)).resolves.toEqual({kind: 'invalidCredentials'});
    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
  });

  it('creates an account and sets its password when registration is open', async() => {
    const user = {_: 'user', id: 42};
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockResolvedValueOnce({_: 'auth.authorization', user});
    const updatePasswordSettings = vi.fn().mockResolvedValue(true);

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'open',
      displayName: 'Alice Example',
      password: 'StrongPassword123',
      updatePasswordSettings
    })).resolves.toEqual({kind: 'authorized', user});

    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual([
      'auth.sendCode',
      'auth.signIn',
      'auth.signUp'
    ]);
    expect(invokeApi).toHaveBeenNthCalledWith(2, 'auth.signIn', {
      phone_number: USERNAME,
      phone_code_hash: 'mock-code-hash',
      phone_code: ''
    }, {ignoreErrors: true});
    expect(invokeApi).toHaveBeenNthCalledWith(3, 'auth.signUp', {
      phone_number: USERNAME,
      phone_code_hash: 'mock-code-hash',
      first_name: 'Alice Example',
      last_name: ''
    });
    expect(updatePasswordSettings).toHaveBeenCalledWith('StrongPassword123');
  });

  it('retries sign-up with the Turnstile token requested by the server', async() => {
    const user = {_: 'user', id: 42};
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockRejectedValueOnce({type: 'RECAPTCHA_CHECK_signup__test-site-key'})
    .mockResolvedValueOnce({_: 'auth.authorization', user});
    const updatePasswordSettings = vi.fn().mockResolvedValue(true);
    const requestTurnstile = vi.fn((siteKey, action, submit) => {
      expect(siteKey).toBe('test-site-key');
      expect(action).toBe('signup');
      return submit('turnstile-token');
    });

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'open',
      displayName: 'Alice Example',
      password: 'StrongPassword123',
      updatePasswordSettings
    }, requestTurnstile)).resolves.toEqual({kind: 'authorized', user});

    expect(invokeApi).toHaveBeenNthCalledWith(4, 'invokeWithReCaptcha', {
      token: 'turnstile-token',
      query: {
        _: 'auth.signUp',
        phone_number: USERNAME,
        phone_code_hash: 'mock-code-hash',
        first_name: 'Alice Example',
        last_name: ''
      }
    });
    expect(updatePasswordSettings).toHaveBeenCalledWith('StrongPassword123');
  });

  it('retries sendCode with a signin Turnstile token', async() => {
    const invokeApi = vi.fn()
    .mockRejectedValueOnce({type: 'RECAPTCHA_CHECK_signin__signin-site-key'})
    .mockResolvedValueOnce(SENT_CODE)
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'});
    const requestTurnstile = vi.fn((siteKey, action, submit) => {
      expect(siteKey).toBe('signin-site-key');
      expect(action).toBe('signin');
      return submit('signin-token');
    });

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, undefined, requestTurnstile))
    .resolves.toEqual({kind: 'password'});

    expect(invokeApi).toHaveBeenNthCalledWith(1, 'auth.sendCode', expect.any(Object));
    expect(invokeApi).toHaveBeenNthCalledWith(2, 'invokeWithReCaptcha', {
      token: 'signin-token',
      query: expect.objectContaining({_: 'auth.sendCode', phone_number: USERNAME})
    });
    expect(invokeApi).toHaveBeenNthCalledWith(3, 'auth.signIn', expect.any(Object), {ignoreErrors: true});
  });

  it('does not request a challenge for an auth.sendCode error', async() => {
    const invokeApi = vi.fn().mockRejectedValue({type: 'RECAPTCHA_CHECK_signup__test-site-key'});
    const requestTurnstile = vi.fn();

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, undefined, requestTurnstile))
    .resolves.toEqual({kind: 'error'});

    expect(requestTurnstile).not.toHaveBeenCalled();
    expect(invokeApi).toHaveBeenCalledOnce();
    expect(invokeApi.mock.calls[0][0]).toBe('auth.sendCode');
  });

  it('sends the invite secret in sign-in phone_code before creating an invited account', async() => {
    const user = {_: 'user', id: 43};
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockResolvedValueOnce({_: 'auth.authorization', user});
    const updatePasswordSettings = vi.fn().mockResolvedValue(true);

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'invite',
      inviteSecret: 'invite-secret',
      displayName: 'Alice Example',
      password: 'StrongPassword123',
      updatePasswordSettings
    })).resolves.toEqual({kind: 'authorized', user});

    expect(invokeApi).toHaveBeenNthCalledWith(2, 'auth.signIn', {
      phone_number: USERNAME,
      phone_code_hash: 'mock-code-hash',
      phone_code: 'invite-secret'
    }, {ignoreErrors: true});
    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual([
      'auth.sendCode',
      'auth.signIn',
      'auth.signUp'
    ]);
  });

  it('does not authorize an account when password setup fails', async() => {
    const user = {_: 'user', id: 44};
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockResolvedValueOnce({_: 'auth.authorization', user});
    const updatePasswordSettings = vi.fn().mockRejectedValue({type: 'PASSWORD_TOO_WEAK'});

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'open',
      displayName: 'Alice Example',
      password: 'weak',
      updatePasswordSettings
    })).resolves.toEqual({kind: 'weakPassword', user});
  });

  it.each(['PHONE_NUMBER_INVALID', 'INPUT_REQUEST_INVALID', 'PASSWORD_HASH_INVALID'])(
    'turns %s into the generic credential failure', async(type) => {
      const invokeApi = vi.fn()
      .mockResolvedValueOnce(SENT_CODE)
      .mockRejectedValueOnce({type});

      await expect(authenticatePrivateUsername(USERNAME, invokeApi)).resolves.toEqual({kind: 'invalidCredentials'});
      expect(invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
    }
  );

  it('stops on a network failure without retrying or switching authentication flow', async() => {
    const invokeApi = vi.fn().mockRejectedValue(new Error('offline'));
    const consoleError = vi.spyOn(console, 'error');

    await expect(authenticatePrivateUsername(USERNAME, invokeApi)).resolves.toEqual({kind: 'error'});
    expect(invokeApi).toHaveBeenCalledOnce();
    expect(invokeApi.mock.calls[0][0]).toBe('auth.sendCode');
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not send sign-in after the card is cancelled while send-code is pending', async() => {
    let cancelled = false;
    const invokeApi = vi.fn((..._args: any[]) => {
      cancelled = true;
      return Promise.resolve(SENT_CODE);
    });

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, () => cancelled)).resolves.toEqual({kind: 'cancelled'});
    expect(invokeApi).toHaveBeenCalledOnce();
    expect(invokeApi.mock.calls[0][0]).toBe('auth.sendCode');
  });

  it('recognizes password hash failures for the username flow error state', () => {
    expect(isPrivateUsernameCredentialError({type: 'PASSWORD_HASH_INVALID'})).toBe(true);
    expect(isPrivateUsernameCredentialError({type: 'SESSION_PASSWORD_NEEDED'})).toBe(false);
    expect(isPrivateUsernameCredentialError({type: 'NETWORK_ERROR'})).toBe(false);
  });
});
