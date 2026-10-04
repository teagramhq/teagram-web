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

  it('turns sign-up-required into the generic credential failure without a registration RPC', async() => {
    const invokeApi = vi.fn()
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}});

    await expect(authenticatePrivateUsername(USERNAME, invokeApi)).resolves.toEqual({kind: 'invalidCredentials'});
    expect(invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
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
