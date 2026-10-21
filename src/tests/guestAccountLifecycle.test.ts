import {afterEach, describe, expect, it, vi} from 'vitest';
import {createGuestAccountLifecycle, generateGuestCredentials} from '@lib/guestAccountLifecycle';
import type {GuestAccountLifecycleDependencies, GuestCredentialPair, GuestServerIdentity} from '@lib/guestAccountLifecycle';
import type {GuestCredentialRecords} from '@lib/guestAccountTypes';

const USER = {_: 'user', id: 42} as any;
const SENT_CODE = {_: 'auth.sentCode', phone_code_hash: 'code-hash'};
const SIGN_UP_REQUIRED = {_: 'auth.authorizationSignUpRequired'};
const IDENTITY: GuestServerIdentity = {serverId: `custom-${'a'.repeat(64)}`, keyFingerprint: 'b'.repeat(64)};

function makeDependencies(overrides: Partial<GuestAccountLifecycleDependencies> = {}) {
  let records: GuestCredentialRecords = [];
  let accountUserId: number | undefined;
  let currentIdentity = IDENTITY;
  let currentAccountNumber: 1 | 2 | 3 | 4 = 1;
  let generated = 0;
  const invokeApi = vi.fn(async(method: string, _params?: any) => {
    if(method === 'auth.sendCode') return SENT_CODE;
    if(method === 'auth.signIn') return SIGN_UP_REQUIRED;
    if(method === 'auth.signUp') return {_: 'auth.authorization', user: USER};
    throw new Error(`Unexpected API method ${method}`);
  });
  const generateCredentials = vi.fn((): GuestCredentialPair => {
    const suffix = String.fromCharCode(97 + generated++ % 26);
    return {username: `guest_${'a'.repeat(15)}${suffix}`, password: 'P'.repeat(43)};
  });
  const setUser = vi.fn(async(user: any) => { accountUserId = Number(user.id); });
  const signInWithPassword = vi.fn(async() => USER);
  const dependencies: GuestAccountLifecycleDependencies = {
    getServerIdentity: () => currentIdentity,
    isServerIdentityCurrent: (identity) => identity.serverId === currentIdentity.serverId &&
      identity.keyFingerprint === currentIdentity.keyFingerprint,
    getCurrentAccountNumber: () => currentAccountNumber,
    getAccountUserId: async() => accountUserId,
    readCredentials: async() => records,
    writeCredentials: async(value) => { records = value.map((record) => ({...record})); },
    withServerLock: async(_name, callback) => callback(),
    generateCredentials,
    invokeApi,
    setUser,
    updatePasswordSettings: async() => true,
    verifyPassword: async() => true,
    signInWithPassword,
    subscribeInvalidation: () => () => {},
    ...overrides
  };

  return {
    dependencies,
    invokeApi,
    generateCredentials,
    get records() { return records; },
    set records(value: GuestCredentialRecords) { records = value; },
    get accountUserId() { return accountUserId; },
    set accountUserId(value: number | undefined) { accountUserId = value; },
    get currentIdentity() { return currentIdentity; },
    set currentIdentity(value: GuestServerIdentity) { currentIdentity = value; },
    get currentAccountNumber() { return currentAccountNumber; },
    set currentAccountNumber(value: 1 | 2 | 3 | 4) { currentAccountNumber = value; }
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('guest account lifecycle', () => {
  it('generates a lowercase username with 80 random bits and a 32-byte password', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xff);
      return bytes;
    });
    vi.stubGlobal('crypto', {getRandomValues});

    const credentials = generateGuestCredentials();

    expect(credentials.username).toMatch(/^guest_[a-z2-7]{16}$/);
    expect(credentials.username.toLowerCase()).toBe(credentials.username);
    expect(credentials.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getRandomValues.mock.calls.map(([bytes]) => bytes.length)).toEqual([10, 32]);
  });

  it('persists the provisional secret before sign-up and commits only after password setup', async() => {
    const state = makeDependencies();
    const write = state.dependencies.writeCredentials;
    const writeSpy = vi.fn(write);
    state.dependencies.writeCredentials = writeSpy;
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') return SIGN_UP_REQUIRED;
      if(method === 'auth.signUp') {
        expect(state.records[0]?.status).toBe('provisional');
        return {_: 'auth.authorization', user: USER};
      }
      throw new Error(`Unexpected API method ${method}`);
    });
    state.dependencies.updatePasswordSettings = async() => {
      expect(state.records[0]?.status).toBe('provisional');
      expect(state.records[0]?.accountUserId).toBe(42);
      return true;
    };

    const lifecycle = createGuestAccountLifecycle(state.dependencies);
    const result = await lifecycle.create();
    expect(result).toMatchObject({kind: 'authorized', username: state.records[0].username});

    expect(writeSpy).toHaveBeenCalledTimes(3);
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({status: 'committed', accountUserId: 42, serverId: IDENTITY.serverId, keyFingerprint: IDENTITY.keyFingerprint});
  });

  it('resumes a timed out password setup with the same secret and reconciles PASSWORD_HASH_INVALID by SRP', async() => {
    const state = makeDependencies();
    state.dependencies.updatePasswordSettings = vi.fn()
    .mockRejectedValueOnce({type: 'NETWORK_ERROR'})
    .mockRejectedValueOnce({type: 'PASSWORD_HASH_INVALID'});
    state.dependencies.verifyPassword = vi.fn().mockResolvedValue(true);
    const lifecycle = createGuestAccountLifecycle(state.dependencies);

    await expect(lifecycle.create()).resolves.toMatchObject({kind: 'setupPending'});
    const saved = {...state.records[0]};
    await expect(lifecycle.create()).resolves.toEqual({kind: 'resumed', username: saved.username, userId: 42});

    expect(state.invokeApi.mock.calls.filter(([method]) => method === 'auth.signUp')).toHaveLength(1);
    expect(state.dependencies.updatePasswordSettings).toHaveBeenNthCalledWith(1, saved.password);
    expect(state.dependencies.updatePasswordSettings).toHaveBeenNthCalledWith(2, saved.password);
    expect(state.dependencies.verifyPassword).toHaveBeenCalledWith(saved.password);
    expect(state.records[0]).toMatchObject({username: saved.username, password: saved.password, status: 'committed'});
  });

  it('reports a lost creating key as unrecoverable without starting a replacement guest', async() => {
    const state = makeDependencies();
    state.dependencies.updatePasswordSettings = async() => { throw {type: 'NETWORK_ERROR'}; };
    const lifecycle = createGuestAccountLifecycle(state.dependencies);
    await lifecycle.create();
    state.accountUserId = undefined;
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') throw {type: 'INTERNAL'};
      if(method === 'auth.signUp') throw new Error('must not create a replacement');
      throw new Error(`Unexpected API method ${method}`);
    });

    await expect(lifecycle.create()).resolves.toEqual({kind: 'unrecoverable', username: state.records[0].username});
    expect(state.records).toHaveLength(1);
    expect(state.invokeApi.mock.calls.filter(([method]) => method === 'auth.signUp')).toHaveLength(1);
  });

  it('does not return a committed guest when the active account slot belongs to another user', async() => {
    const state = makeDependencies();
    state.accountUserId = 99;
    state.records = [{
      version: 1,
      serverId: IDENTITY.serverId,
      keyFingerprint: IDENTITY.keyFingerprint,
      username: `guest_${'a'.repeat(16)}`,
      password: 'P'.repeat(43),
      status: 'committed',
      accountUserId: 42,
      accountNumber: 1
    }];

    await expect(createGuestAccountLifecycle(state.dependencies).create()).resolves.toEqual({kind: 'accountInUse'});

    expect(state.invokeApi).not.toHaveBeenCalled();
    expect(state.generateCredentials).not.toHaveBeenCalled();
  });

  it('keeps the same provisional username when the sign-up response itself times out', async() => {
    const state = makeDependencies();
    state.invokeApi.mockImplementationOnce(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      throw new Error(`Unexpected API method ${method}`);
    });
    state.invokeApi.mockImplementationOnce(async(method) => {
      if(method === 'auth.signIn') return SIGN_UP_REQUIRED;
      throw new Error(`Unexpected API method ${method}`);
    });
    state.invokeApi.mockImplementationOnce(async() => { throw {type: 'NETWORK_ERROR'}; });
    const lifecycle = createGuestAccountLifecycle(state.dependencies);

    await expect(lifecycle.create()).resolves.toMatchObject({kind: 'error', errorType: 'NETWORK_ERROR'});
    const saved = {...state.records[0]};
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') throw {type: 'INTERNAL'};
      throw new Error('must not create a second account');
    });

    await expect(lifecycle.create()).resolves.toEqual({kind: 'unrecoverable', username: saved.username});
    expect(state.records[0]).toMatchObject({username: saved.username, password: saved.password, status: 'provisional'});
    expect(state.generateCredentials).toHaveBeenCalledOnce();
  });

  it('retries only username collisions up to three times with a fresh Turnstile token per sign-up', async() => {
    const state = makeDependencies();
    const challengeTokens: string[] = [];
    const requestTurnstile = vi.fn(async(_siteKey: string, _action: string, submit: (token: string) => Promise<unknown>) => {
      const token = `token-${challengeTokens.length + 1}`;
      challengeTokens.push(token);
      return submit(token);
    });
    state.dependencies.requestTurnstile = requestTurnstile as any;
    state.dependencies.turnstileSiteKey = 'demo-site-key';
    state.invokeApi.mockImplementation(async(method, params) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') return SIGN_UP_REQUIRED;
      if(method === 'invokeWithReCaptcha') throw {type: 'USERNAME_OCCUPIED'};
      throw new Error(`Unexpected API method ${method}`);
    });
    const lifecycle = createGuestAccountLifecycle(state.dependencies);

    await expect(lifecycle.create()).resolves.toEqual({kind: 'collisionsExhausted'});

    const signUpCalls = state.invokeApi.mock.calls.filter(([method]) => method === 'invokeWithReCaptcha');
    expect(challengeTokens).toEqual(['token-1', 'token-2', 'token-3']);
    expect(signUpCalls.map(([, params]) => params.token)).toEqual(challengeTokens);
    expect(signUpCalls.map(([, params]) => params.query.phone_number)).toHaveLength(3);
    expect(new Set(signUpCalls.map(([, params]) => params.query.phone_number)).size).toBe(3);
    expect(state.records).toHaveLength(0);
  });

  it('treats SESSION_PASSWORD_NEEDED at sign-in as a collision and never adopts that account', async() => {
    const state = makeDependencies();
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') throw {type: 'SESSION_PASSWORD_NEEDED'};
      throw new Error('must not sign up or adopt a colliding account');
    });

    await expect(createGuestAccountLifecycle(state.dependencies).create()).resolves.toEqual({kind: 'collisionsExhausted'});
    expect(state.generateCredentials).toHaveBeenCalledTimes(3);
    expect(state.dependencies.signInWithPassword).not.toHaveBeenCalled();
    expect(state.invokeApi.mock.calls.map(([method]) => method)).toEqual([
      'auth.sendCode', 'auth.signIn',
      'auth.sendCode', 'auth.signIn',
      'auth.sendCode', 'auth.signIn'
    ]);
  });

  it.each(['INTERNAL', 'FLOOD_WAIT_60', 'NETWORK_ERROR'])('stops without retrying after %s', async(type) => {
    const state = makeDependencies();
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') throw {type};
      throw new Error('must not retry');
    });

    await expect(createGuestAccountLifecycle(state.dependencies).create()).resolves.toEqual({kind: 'error', errorType: type});
    expect(state.generateCredentials).toHaveBeenCalledTimes(1);
    expect(state.invokeApi.mock.calls.filter(([method]) => method === 'auth.signIn')).toHaveLength(1);
  });

  it('cancels when the selected server key changes during sign-up', async() => {
    const state = makeDependencies();
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') return SIGN_UP_REQUIRED;
      if(method === 'auth.signUp') {
        state.currentIdentity = {...IDENTITY, keyFingerprint: 'c'.repeat(64)};
        return {_: 'auth.authorization', user: USER};
      }
      throw new Error(`Unexpected API method ${method}`);
    });

    await expect(createGuestAccountLifecycle(state.dependencies).create()).resolves.toEqual({kind: 'cancelled'});
    expect(state.records[0]).toMatchObject({status: 'provisional'});
    expect(state.records[0].accountUserId).toBeUndefined();
  });

  it('cancels when the account slot changes while sign-up is pending', async() => {
    const state = makeDependencies();
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') return SIGN_UP_REQUIRED;
      if(method === 'auth.signUp') {
        state.currentAccountNumber = 2;
        return {_: 'auth.authorization', user: USER};
      }
      throw new Error(`Unexpected API method ${method}`);
    });

    await expect(createGuestAccountLifecycle(state.dependencies).create()).resolves.toEqual({kind: 'cancelled'});
    expect(state.records[0]).toMatchObject({status: 'provisional'});
    expect(state.records[0].accountUserId).toBeUndefined();
  });

  it('cancels when another tab forgets the guest while password setup is pending', async() => {
    const state = makeDependencies();
    let invalidate = () => {};
    state.dependencies.subscribeInvalidation = (_serverId, callback) => {
      invalidate = callback;
      return () => {};
    };
    state.dependencies.updatePasswordSettings = async() => {
      invalidate();
      return true;
    };

    await expect(createGuestAccountLifecycle(state.dependencies).create()).resolves.toEqual({kind: 'cancelled'});
    expect(state.records[0]).toMatchObject({status: 'provisional', accountUserId: 42});
    expect(state.records[0].status).not.toBe('committed');
  });

  it('reauthenticates a returning guest through SRP without creating or adopting another account', async() => {
    const state = makeDependencies();
    state.accountUserId = 42;
    state.records = [{
      version: 1,
      serverId: IDENTITY.serverId,
      keyFingerprint: IDENTITY.keyFingerprint,
      username: `guest_${'a'.repeat(16)}`,
      password: 'P'.repeat(43),
      status: 'committed',
      accountUserId: 42,
      accountNumber: 1
    }];
    state.dependencies.signInWithPassword = vi.fn().mockResolvedValue(USER);
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') throw {type: 'SESSION_PASSWORD_NEEDED'};
      throw new Error(`Unexpected API method ${method}`);
    });

    await expect(createGuestAccountLifecycle(state.dependencies).reauthenticate()).resolves.toMatchObject({kind: 'authorized', user: USER});
    expect(state.dependencies.signInWithPassword).toHaveBeenCalledWith('P'.repeat(43));
    expect(state.invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
    expect(state.records[0].status).toBe('committed');
  });

  it('does not treat a missing username after a wipe as permission to attach or replace its cache', async() => {
    const state = makeDependencies();
    state.records = [{
      version: 1,
      serverId: IDENTITY.serverId,
      keyFingerprint: IDENTITY.keyFingerprint,
      username: `guest_${'a'.repeat(16)}`,
      password: 'P'.repeat(43),
      status: 'committed',
      accountUserId: 42,
      accountNumber: 1
    }];
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') return SIGN_UP_REQUIRED;
      throw new Error('must not create an account');
    });

    await expect(createGuestAccountLifecycle(state.dependencies).reauthenticate()).resolves.toEqual({kind: 'unrecoverable', username: state.records[0].username});
    expect(state.records).toHaveLength(1);
    expect(state.dependencies.setUser).not.toHaveBeenCalled();
    expect(state.invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
  });

  it('does not attach a saved guest record to a different user after username reuse', async() => {
    const state = makeDependencies();
    state.records = [{
      version: 1,
      serverId: IDENTITY.serverId,
      keyFingerprint: IDENTITY.keyFingerprint,
      username: `guest_${'a'.repeat(16)}`,
      password: 'P'.repeat(43),
      status: 'committed',
      accountUserId: 42,
      accountNumber: 1
    }];
    state.dependencies.signInWithPassword = vi.fn().mockResolvedValue({...USER, id: 99});
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') return SENT_CODE;
      if(method === 'auth.signIn') throw {type: 'SESSION_PASSWORD_NEEDED'};
      throw new Error(`Unexpected API method ${method}`);
    });

    await expect(createGuestAccountLifecycle(state.dependencies).reauthenticate()).resolves.toEqual({
      kind: 'error',
      errorType: 'GUEST_ACCOUNT_MISMATCH'
    });
    expect(state.dependencies.setUser).not.toHaveBeenCalled();
    expect(state.records[0].accountUserId).toBe(42);
  });

  it('stops reauthentication when the pinned server key changes before password verification', async() => {
    const state = makeDependencies();
    state.records = [{
      version: 1,
      serverId: IDENTITY.serverId,
      keyFingerprint: IDENTITY.keyFingerprint,
      username: `guest_${'a'.repeat(16)}`,
      password: 'P'.repeat(43),
      status: 'committed',
      accountUserId: 42,
      accountNumber: 1
    }];
    state.invokeApi.mockImplementation(async(method) => {
      if(method === 'auth.sendCode') {
        state.currentIdentity = {...IDENTITY, keyFingerprint: 'c'.repeat(64)};
        return SENT_CODE;
      }
      throw new Error('must not verify a password against a changed key');
    });

    await expect(createGuestAccountLifecycle(state.dependencies).reauthenticate()).resolves.toEqual({kind: 'cancelled'});
    expect(state.dependencies.signInWithPassword).not.toHaveBeenCalled();
    expect(state.records[0].status).toBe('committed');
  });

  it('forgets the stored guest secret, revokes the session and notifies other tabs', async() => {
    const state = makeDependencies();
    state.accountUserId = 42;
    state.records = [{
      version: 1,
      serverId: IDENTITY.serverId,
      keyFingerprint: IDENTITY.keyFingerprint,
      username: `guest_${'a'.repeat(16)}`,
      password: 'P'.repeat(43),
      status: 'committed',
      accountUserId: 42,
      accountNumber: 1
    }];
    const logOut = vi.fn().mockResolvedValue(undefined);
    const notifyInvalidation = vi.fn();
    state.dependencies.logOut = logOut;
    state.dependencies.notifyInvalidation = notifyInvalidation;

    await expect(createGuestAccountLifecycle(state.dependencies).forget()).resolves.toEqual({kind: 'forgotten'});

    expect(state.records).toHaveLength(0);
    expect(logOut).toHaveBeenCalledWith(1);
    expect(notifyInvalidation).toHaveBeenCalledWith(IDENTITY.serverId);
  });

  it('revokes the guest session from its shifted account slot', async() => {
    const state = makeDependencies();
    state.accountUserId = 42;
    state.currentAccountNumber = 2;
    state.records = [{
      version: 1,
      serverId: IDENTITY.serverId,
      keyFingerprint: IDENTITY.keyFingerprint,
      username: `guest_${'a'.repeat(16)}`,
      password: 'P'.repeat(43),
      status: 'committed',
      accountUserId: 42,
      accountNumber: 1
    }];
    const logOut = vi.fn().mockResolvedValue(undefined);
    state.dependencies.logOut = logOut;

    await expect(createGuestAccountLifecycle(state.dependencies).forget()).resolves.toEqual({kind: 'forgotten'});

    expect(logOut).toHaveBeenCalledWith(2);
    expect(state.records).toHaveLength(0);
  });
});
