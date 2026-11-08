import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {GuestCredentialRecord} from '@lib/guestAccountTypes';
import {createGuestAccountLifecycle, type GuestAccountLifecycleDependencies} from '@lib/guestAccountLifecycle';

const mocks = vi.hoisted(() => ({
  records: [] as any[],
  accountData: {} as Record<number, any>,
  getTotalAccounts: vi.fn(async() => 2),
  getAccount: vi.fn(async(accountNumber: number) => mocks.accountData[accountNumber] || {}),
  hasUserIdInOtherAccounts: vi.fn(async(accountNumber: number, userId: number) => Object.entries(mocks.accountData)
  .some(([otherAccountNumber, accountData]) => Number(otherAccountNumber) !== accountNumber &&
    String(accountData.userId) === String(userId))),
  clearAccountLocalState: vi.fn(async(accountNumber: number) => {
    for(let current = accountNumber; current < 4; ++current) {
      mocks.accountData[current] = mocks.accountData[current + 1];
    }
    delete mocks.accountData[4];
  }),
  get: vi.fn(async() => mocks.records),
  set: vi.fn(async({guestCredentials}: {guestCredentials: any[]}) => { mocks.records = guestCredentials; }),
  delete: vi.fn(async() => { mocks.records = []; }),
  flush: vi.fn(async() => {}),
  notify: vi.fn()
}));

vi.mock('@lib/sessionStorage', () => ({default: {get: mocks.get, set: mocks.set, delete: mocks.delete, flush: mocks.flush}}));
vi.mock('@lib/accounts/accountController', () => ({default: {
  getTotalAccounts: mocks.getTotalAccounts,
  get: mocks.getAccount,
  hasUserIdInOtherAccounts: mocks.hasUserIdInOtherAccounts
}}));
vi.mock('@lib/guestAccountLocalCleanup', () => ({
  clearGuestAccountLocalState: mocks.clearAccountLocalState,
  clearInvalidatedGuestAccount: vi.fn()
}));
vi.mock('@lib/guestCredentialBroadcast', () => ({notifyGuestCredentialInvalidation: mocks.notify}));

import {clearAllGuestCredentials, clearGuestCredentialsForAccount, saveGuestCredentials} from '@lib/guestCredentialStorage';
import {ApiManager} from '@appManagers/apiManager';
import type {ActiveAccountNumber} from '@lib/accounts/types';

const guest = (username: string, accountUserId?: number, accountNumber?: 1 | 2 | 3 | 4): GuestCredentialRecord => ({
  version: 1,
  serverId: 'custom-server-a',
  keyFingerprint: 'pinned-key-a',
  username,
  password: 'P'.repeat(43),
  status: accountUserId ? 'committed' : 'provisional',
  accountUserId,
  accountNumber
});

beforeEach(() => {
  mocks.records = [];
  mocks.accountData = {};
  vi.clearAllMocks();
});

describe('guest credential cleanup', () => {
  it('preserves and reauthenticates a slot-two guest after stale slot-one logout', async() => {
    const user = {_: 'user', id: 17} as any;
    const identity = {serverId: 'custom-server-a', keyFingerprint: 'pinned-key-a'};
    const sentCode = {_: 'auth.sentCode', phone_code_hash: 'code-hash'};
    let accountNumber: 1 | 2 = 2;
    let accountUserId: number | undefined;
    let signInCount = 0;
    const signInWithPassword = vi.fn(async() => user);
    const dependencies: GuestAccountLifecycleDependencies = {
      getServerIdentity: () => identity,
      isServerIdentityCurrent: () => true,
      getCurrentAccountNumber: () => accountNumber,
      getAccountUserId: async() => accountUserId,
      readCredentials: async() => mocks.records,
      writeCredentials: async(records) => { await saveGuestCredentials(records); },
      clearInvalidatedAccount: async() => {},
      withServerLock: async(_name, callback) => callback(),
      generateCredentials: () => ({username: `guest_${'a'.repeat(16)}`, password: 'P'.repeat(43)}),
      invokeApi: async(method) => {
        if(method === 'auth.sendCode') return sentCode;
        if(method === 'auth.signIn') {
          ++signInCount;
          return signInCount === 1 ? {_: 'auth.authorizationSignUpRequired'} : Promise.reject({type: 'SESSION_PASSWORD_NEEDED'});
        }
        if(method === 'auth.signUp') return {_: 'auth.authorization', user};
        throw new Error(`Unexpected API method ${method}`);
      },
      setUser: async(authorizedUser) => { accountUserId = Number(authorizedUser.id); },
      updatePasswordSettings: async() => true,
      verifyPassword: async() => true,
      signInWithPassword,
      subscribeInvalidation: () => () => {}
    };
    const lifecycle = createGuestAccountLifecycle(dependencies);

    await expect(lifecycle.create()).resolves.toMatchObject({kind: 'authorized', user});
    expect(mocks.records[0]).toMatchObject({accountNumber: 2, accountUserId: 17});

    mocks.accountData = {
      1: {userId: 17, dc1_auth_key: 'stale-auth-key'},
      2: {userId: 17, newAccountUserId: 17, dc1_auth_key: 'new-auth-key'}
    };
    const manager = Object.create(ApiManager.prototype) as ApiManager;
    Object.assign(manager, {
      accountNumber: 1 as ActiveAccountNumber,
      baseDcId: 2,
      invokeApi: vi.fn(async() => undefined),
      log: {error: vi.fn()},
      rootScope: {dispatchEvent: vi.fn()}
    });

    vi.useFakeTimers();
    try {
      await manager.logOut();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }

    expect(mocks.records).toHaveLength(1);
    expect(mocks.hasUserIdInOtherAccounts).toHaveBeenCalledWith(1, 17);
    expect(mocks.accountData[1]).toMatchObject({userId: 17, newAccountUserId: 17});
    expect(mocks.accountData[2]).toBeUndefined();

    accountNumber = 1;
    await expect(lifecycle.reauthenticate()).resolves.toMatchObject({kind: 'authorized', user});
    expect(signInWithPassword).toHaveBeenCalledWith('P'.repeat(43));
  });

  it('finds the guest by account ID after its account slot shifts', async() => {
    mocks.records = [guest('guest_a', 42, 1), guest('guest_b', 44, 2)];

    await clearGuestCredentialsForAccount(42, 2);

    expect(mocks.records).toEqual([guest('guest_b', 44, 2)]);
    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('clears an unbound provisional credential when its account slot is logged out', async() => {
    mocks.records = [guest('guest_a', undefined, 2), guest('guest_b', 44, 1)];

    await clearGuestCredentialsForAccount(undefined, 2);

    expect(mocks.records).toEqual([guest('guest_b', 44, 1)]);
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('clears every guest secret on force logout and notifies tabs for that server', async() => {
    mocks.records = [guest('guest_a', 42, 1)];

    await clearAllGuestCredentials('custom-server-a');

    expect(mocks.delete).toHaveBeenCalledWith('guestCredentials');
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.records).toEqual([]);
    expect(mocks.notify).toHaveBeenCalledWith('custom-server-a');
  });

  it('does not resolve credential writes before the durable storage flush completes', async() => {
    let finishFlush!: () => void;
    mocks.flush.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    let saved = false;

    const saving = saveGuestCredentials([guest('guest_saved')]).then(() => { saved = true; });
    await Promise.resolve();

    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(saved).toBe(false);

    finishFlush();
    await saving;
    expect(saved).toBe(true);
  });
});
