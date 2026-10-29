import {describe, expect, it, vi} from 'vitest';
import type {HelpTermsOfService} from '@layer';

import {authenticatePrivateUsername, isPrivateUsername, isPrivateUsernameCredentialError, parsePrivateUsernameInviteSecret} from '@/pages/privateUsernameAuth';
import {
  capturePrivateUsernameInviteSecretFromFragment,
  restorePrivateUsernameInviteSecretForRetry,
  storePrivateUsernameInviteSecretForAccountSwitch,
  takePrivateUsernameInviteSecretFromFragment
} from '@/pages/privateUsernameInvite';

const USERNAME = 'Alice_123';
const SENT_CODE = {
  _: 'auth.sentCode',
  phone_code_hash: 'mock-code-hash',
  type: {_ : 'auth.sentCodeTypeApp', length: 5},
  timeout: 60
};

describe('private username sign-in', () => {
  it('normalizes invite codes and invite links to a 64-character secret', () => {
    const secret = 'a'.repeat(64);

    expect(parsePrivateUsernameInviteSecret(secret)).toBe(secret);
    expect(parsePrivateUsernameInviteSecret(secret.toUpperCase())).toBe(secret);
    expect(parsePrivateUsernameInviteSecret(`https://teagram.example/#${secret}`)).toBe(secret);
    expect(parsePrivateUsernameInviteSecret(`https://teagram.example/?invite=${secret}`)).toBeUndefined();
    expect(parsePrivateUsernameInviteSecret('not-an-invite')).toBeUndefined();
  });

  it('strips a valid invite fragment before handing it to the auth card', () => {
    const secret = 'b'.repeat(64);
    window.history.replaceState(window.history.state, '', `/?keep=1#${secret}`);

    capturePrivateUsernameInviteSecretFromFragment();

    expect(window.location.search).toBe('?keep=1');
    expect(window.location.hash).toBe('');
    expect(takePrivateUsernameInviteSecretFromFragment()).toBe(secret);
    expect(takePrivateUsernameInviteSecretFromFragment()).toBeUndefined();
  });

  it('clears an older pending secret when a fresh fragment arrives', () => {
    const secret = 'e'.repeat(64);
    window.sessionStorage.setItem('teagram-invite-secret', 'f'.repeat(64));
    window.history.replaceState(window.history.state, '', `/?keep=1#${secret}`);

    capturePrivateUsernameInviteSecretFromFragment();

    expect(takePrivateUsernameInviteSecretFromFragment()).toBe(secret);
    expect(window.sessionStorage.getItem('teagram-invite-secret')).toBeNull();
  });

  it('passes an invite across an account switch through session storage once', () => {
    const secret = 'c'.repeat(64);

    expect(storePrivateUsernameInviteSecretForAccountSwitch(secret.toUpperCase())).toBe(true);
    expect(window.sessionStorage.getItem('teagram-invite-secret')).toBe(secret);
    expect(takePrivateUsernameInviteSecretFromFragment()).toBe(secret);
    expect(window.sessionStorage.getItem('teagram-invite-secret')).toBeNull();
    expect(takePrivateUsernameInviteSecretFromFragment()).toBeUndefined();
  });

  it('requires session storage to hand an invite across an account switch', () => {
    const secret = 'd'.repeat(64);
    const sessionStorage = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage unavailable', 'SecurityError');
      }
    });

    try {
      expect(storePrivateUsernameInviteSecretForAccountSwitch(secret)).toBe(false);
      expect(takePrivateUsernameInviteSecretFromFragment()).toBeUndefined();
    } finally {
      if(sessionStorage) Object.defineProperty(window, 'sessionStorage', sessionStorage);
      else delete (window as any).sessionStorage;
    }
  });

  it('restores an invite fragment after a failed account switch for retry', () => {
    const secret = 'a'.repeat(64);
    window.history.replaceState(window.history.state, '', '/invite?keep=1');
    window.sessionStorage.setItem('teagram-invite-secret', secret);

    expect(restorePrivateUsernameInviteSecretForRetry(secret.toUpperCase())).toBe(true);
    expect(window.location.search).toBe('?keep=1');
    expect(window.location.hash).toBe(`#${secret}`);
    expect(window.sessionStorage.getItem('teagram-invite-secret')).toBe(secret);
  });

  it('restores through app navigation when session storage is unavailable', () => {
    const secret = 'b'.repeat(64);
    const sessionStorage = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const restoreFragment = vi.fn((normalizedSecret: string) => {
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}#${normalizedSecret}`
      );
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage unavailable', 'SecurityError');
      }
    });

    try {
      expect(restorePrivateUsernameInviteSecretForRetry(secret, restoreFragment)).toBe(true);
      expect(restoreFragment).toHaveBeenCalledWith(secret);
      expect(window.location.hash).toBe(`#${secret}`);
    } finally {
      if(sessionStorage) Object.defineProperty(window, 'sessionStorage', sessionStorage);
      else delete (window as any).sessionStorage;
    }
  });

  it('applies the username limits and pattern supplied by appConfig', () => {
    const appConfig = {
      username_min_length: 2,
      username_max_length: 4,
      username_pattern: '^[a-z][a-z0-9_]{1,3}$'
    };

    expect(isPrivateUsername('ab', appConfig)).toBe(true);
    expect(isPrivateUsername('a_1b', appConfig)).toBe(true);
    expect(isPrivateUsername('a', appConfig)).toBe(false);
    expect(isPrivateUsername('abcde', appConfig)).toBe(false);
    expect(isPrivateUsername('1a', appConfig)).toBe(false);
    expect(isPrivateUsername('a-b', appConfig)).toBe(false);
  });

  it('allows a non-empty username when an older server omits username rules', () => {
    expect(isPrivateUsername('a')).toBe(true);
    expect(isPrivateUsername('A'.repeat(40))).toBe(true);
    expect(isPrivateUsername('')).toBe(false);
  });

  it('rejects malformed input before making an authentication RPC', async() => {
    const invokeApi = vi.fn();

    await expect(authenticatePrivateUsername('', invokeApi)).resolves.toEqual({kind: 'invalidInput'});
    expect(invokeApi).not.toHaveBeenCalled();
  });

  it('rejects a malformed invite secret before making an authentication RPC', async() => {
    const invokeApi = vi.fn();

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'invite',
      inviteSecret: 'not-an-invite',
      displayName: 'Alice Example',
      password: 'StrongPassword123',
      updatePasswordSettings: vi.fn()
    })).resolves.toEqual({kind: 'invalidInput'});

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

  it('waits for server terms acceptance before creating an account', async() => {
    const user = {_: 'user', id: 42};
    const termsOfService: HelpTermsOfService = {
      _: 'help.termsOfService',
      id: {_ : 'dataJSON', data: '{"terms":"guest"}'},
      text: 'Read these terms first.',
      entities: [],
      pFlags: {popup: true}
    };
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: termsOfService})
    .mockResolvedValueOnce({_: 'auth.authorization', user});
    const requestTermsAcceptance = vi.fn().mockResolvedValue(true);

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'open',
      displayName: 'Alice Example',
      password: 'StrongPassword123',
      updatePasswordSettings: vi.fn().mockResolvedValue(true),
      requestTermsAcceptance
    })).resolves.toEqual({kind: 'authorized', user});

    expect(requestTermsAcceptance).toHaveBeenCalledWith(termsOfService);
    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual([
      'auth.sendCode',
      'auth.signIn',
      'auth.signUp'
    ]);
  });

  it('does not create an account when the server terms are declined', async() => {
    const termsOfService: HelpTermsOfService = {
      _: 'help.termsOfService',
      id: {_ : 'dataJSON', data: '{"terms":"guest"}'},
      text: 'Read these terms first.',
      entities: [],
      pFlags: {popup: true}
    };
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: termsOfService});
    const requestTermsAcceptance = vi.fn().mockResolvedValue(false);

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'open',
      displayName: 'Alice Example',
      password: 'StrongPassword123',
      updatePasswordSettings: vi.fn().mockResolvedValue(true),
      requestTermsAcceptance
    })).resolves.toEqual({kind: 'termsDeclined'});

    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
  });

  it('distinguishes a terms dialog failure from a visitor declining terms', async() => {
    const termsOfService: HelpTermsOfService = {
      _: 'help.termsOfService',
      id: {_ : 'dataJSON', data: '{"terms":"guest"}'},
      text: 'Read these terms first.',
      entities: [],
      pFlags: {popup: true}
    };
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: termsOfService});
    const requestTermsAcceptance = vi.fn().mockRejectedValue(new Error('Terms dialog failed to load'));

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'open',
      displayName: 'Alice Example',
      password: 'StrongPassword123',
      updatePasswordSettings: vi.fn().mockResolvedValue(true),
      requestTermsAcceptance
    })).resolves.toEqual({kind: 'termsAcceptanceError'});

    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
  });

  it('persists the creating authorization before attempting password setup', async() => {
    const user = {_: 'user', id: 42};
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockResolvedValueOnce({_: 'auth.authorization', user});
    const calls: string[] = [];
    const onAuthorization = vi.fn(async() => { calls.push('authorization'); });

    await authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'open',
      displayName: 'Alice Example',
      password: 'StrongPassword123',
      updatePasswordSettings: async() => {
        calls.push('password');
        return true;
      },
      onAuthorization
    } as any);

    expect(calls).toEqual(['authorization', 'password']);
    expect(onAuthorization).toHaveBeenCalledWith(user, true);
  });

  it('can verify a saved password after sign-in requires one', async() => {
    const user = {_: 'user', id: 42};
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'});
    const checkPassword = vi.fn().mockResolvedValue(user);
    const onAuthorization = vi.fn();

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'closed',
      displayName: '',
      password: 'saved-password',
      updatePasswordSettings: vi.fn(),
      checkPassword,
      onAuthorization
    } as any)).resolves.toEqual({kind: 'authorized', user});

    expect(checkPassword).toHaveBeenCalledWith('saved-password');
    expect(onAuthorization).toHaveBeenCalledWith(user, false);
    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
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

  it('surfaces Turnstile cancellation without retrying registration', async() => {
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}});
    const requestTurnstile = vi.fn(async() => { throw new Error('Turnstile challenge cancelled'); });

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'open',
      displayName: 'Alice Example',
      password: 'StrongPassword123',
      updatePasswordSettings: vi.fn()
    }, requestTurnstile, 'site-key')).resolves.toEqual({kind: 'cancelled'});

    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
    expect(requestTurnstile).toHaveBeenCalledOnce();
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

  it.each([
    [{code: -404, type: 'AUTH_KEY_UNKNOWN'}, 'AUTH_KEY_UNKNOWN'],
    [{code: -429, type: 'AUTH_KEY_RATE_LIMIT'}, 'AUTH_KEY_RATE_LIMIT']
  ])('returns a retryable classified error for %s without replaying auth.sendCode', async(error, errorType) => {
    const invokeApi = vi.fn().mockRejectedValue(error);

    await expect(authenticatePrivateUsername(USERNAME, invokeApi)).resolves.toEqual({kind: 'error', errorType});
    expect(invokeApi).toHaveBeenCalledOnce();
    expect(invokeApi.mock.calls[0][0]).toBe('auth.sendCode');
  });

  it('rekeys once after AUTH_KEY_UNKNOWN and retries only the rejected sign-in call', async() => {
    const unknownKey = {code: -404, type: 'AUTH_KEY_UNKNOWN', authKeyRecoveryId: 17};
    const invokeApi = vi.fn()
    .mockRejectedValueOnce(unknownKey)
    .mockResolvedValueOnce(SENT_CODE)
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'});
    const recoverAuthKey = vi.fn().mockResolvedValue(true);

    await expect(authenticatePrivateUsername(
      USERNAME,
      invokeApi,
      undefined,
      undefined,
      undefined,
      undefined,
      recoverAuthKey
    )).resolves.toEqual({kind: 'password'});

    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual([
      'auth.sendCode',
      'auth.sendCode',
      'auth.signIn'
    ]);
    expect(recoverAuthKey).toHaveBeenCalledOnce();
    expect(recoverAuthKey).toHaveBeenCalledWith(unknownKey, true);
  });

  it('does not rekey or replay after AUTH_KEY_UNKNOWN on the replacement key', async() => {
    const firstUnknownKey = {code: -404, type: 'AUTH_KEY_UNKNOWN', authKeyRecoveryId: 17};
    const secondUnknownKey = {code: -404, type: 'AUTH_KEY_UNKNOWN', authKeyRecoveryId: 18};
    const invokeApi = vi.fn()
    .mockRejectedValueOnce(firstUnknownKey)
    .mockRejectedValueOnce(secondUnknownKey);
    const recoverAuthKey = vi.fn().mockResolvedValue(true);

    await expect(authenticatePrivateUsername(
      USERNAME,
      invokeApi,
      undefined,
      undefined,
      undefined,
      undefined,
      recoverAuthKey
    )).resolves.toEqual({kind: 'error', errorType: 'AUTH_KEY_UNKNOWN'});

    expect(invokeApi).toHaveBeenCalledTimes(2);
    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.sendCode']);
    expect(recoverAuthKey.mock.calls).toEqual([
      [firstUnknownKey, true],
      [secondUnknownKey, false]
    ]);
  });

  it('does not rekey an auth key rate-limit response', async() => {
    const invokeApi = vi.fn().mockRejectedValue({code: -429, type: 'AUTH_KEY_RATE_LIMIT'});
    const recoverAuthKey = vi.fn();

    await expect(authenticatePrivateUsername(
      USERNAME,
      invokeApi,
      undefined,
      undefined,
      undefined,
      undefined,
      recoverAuthKey
    )).resolves.toEqual({kind: 'error', errorType: 'AUTH_KEY_RATE_LIMIT'});

    expect(invokeApi).toHaveBeenCalledOnce();
    expect(recoverAuthKey).not.toHaveBeenCalled();
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
      inviteSecret: 'a'.repeat(64),
      displayName: 'Alice Example',
      password: 'StrongPassword123',
      updatePasswordSettings
    })).resolves.toEqual({kind: 'authorized', user});

    expect(invokeApi).toHaveBeenNthCalledWith(2, 'auth.signIn', {
      phone_number: USERNAME,
      phone_code_hash: 'mock-code-hash',
      phone_code: 'a'.repeat(64)
    }, {ignoreErrors: true});
    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual([
      'auth.sendCode',
      'auth.signIn',
      'auth.signUp'
    ]);
  });

  it('does not authorize an account when the server rejects the password verifier', async() => {
    const user = {_: 'user', id: 44};
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockResolvedValueOnce({_: 'auth.authorization', user});
    const updatePasswordSettings = vi.fn().mockRejectedValue({type: 'NEW_PASSWORD_BAD'});

    await expect(authenticatePrivateUsername(USERNAME, invokeApi, undefined, {
      mode: 'open',
      displayName: 'Alice Example',
      password: 'weak',
      updatePasswordSettings
    })).resolves.toEqual({kind: 'passwordSetupError', user, errorType: 'NEW_PASSWORD_BAD'});
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
