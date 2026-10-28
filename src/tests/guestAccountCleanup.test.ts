import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  getTotalAccounts: vi.fn(async() => 1),
  hasUserIdInOtherAccounts: vi.fn(async() => false),
  shiftAccounts: vi.fn(async() => {}),
  clearAccountStores: vi.fn(async() => {}),
  clearSessionStores: vi.fn(async() => {}),
  shiftStorages: vi.fn(async() => {}),
  commonClear: vi.fn(async() => {}),
  encryptedClear: vi.fn(async() => {}),
  cacheDeleteAll: vi.fn(async() => {}),
  closeDatabases: vi.fn(),
  isUsingPasscode: vi.fn(async() => false),
  saveEncryptionKey: vi.fn(async() => {})
}));

vi.mock('@lib/accounts/accountController', () => ({default: {
  getTotalAccounts: mocks.getTotalAccounts,
  hasUserIdInOtherAccounts: mocks.hasUserIdInOtherAccounts,
  shiftAccounts: mocks.shiftAccounts
}}));
vi.mock('@appManagers/appStoragesManager', () => ({AppStoragesManager: {
  clearAllStoresForAccount: mocks.clearAccountStores,
  clearSessionStores: mocks.clearSessionStores,
  shiftStorages: mocks.shiftStorages
}}));
vi.mock('@lib/commonStateStorage', () => ({default: {clear: mocks.commonClear}}));
vi.mock('@lib/encryptedStorageLayer', () => ({default: {getInstance: () => ({clear: mocks.encryptedClear})}}));
vi.mock('@config/databases/state', () => ({getCommonDatabaseState: () => ({})}));
vi.mock('@lib/files/cacheStorage', () => ({default: {deleteAllStorages: mocks.cacheDeleteAll}}));
vi.mock('@lib/files/idb', () => ({IDB: {closeDatabases: mocks.closeDatabases}}));
vi.mock('@lib/passcode/deferredIsUsingPasscode', () => ({default: {isUsingPasscode: mocks.isUsingPasscode}}));
vi.mock('@lib/passcode/keyHandoff', () => ({saveEncryptionKeyForHandoff: mocks.saveEncryptionKey}));

import sessionStorage from '@lib/sessionStorage';
import {createGuestAccountLifecycle, type GuestAccountLifecycleDependencies} from '@lib/guestAccountLifecycle';
import {clearInvalidatedGuestAccount} from '@lib/guestAccountLocalCleanup';

const identity = {serverId: `custom-${'a'.repeat(64)}`, keyFingerprint: 'b'.repeat(64)};
const savedRecord = {
  version: 1 as const,
  serverId: identity.serverId,
  keyFingerprint: identity.keyFingerprint,
  username: `guest_${'a'.repeat(16)}`,
  password: 'P'.repeat(43),
  status: 'committed' as const,
  accountUserId: 42,
  accountNumber: 1 as const
};
const sentCode = {_: 'auth.sentCode', phone_code_hash: 'code-hash'};
const otherUser = {_: 'user', id: 99};

function createLifecycle(overrides: Partial<GuestAccountLifecycleDependencies> = {}) {
  const invokeApi = vi.fn(async(method: string) => {
    if(method === 'auth.sendCode') return sentCode;
    if(method === 'auth.signIn') throw {type: 'SESSION_PASSWORD_NEEDED'};
    throw new Error(`Unexpected API method ${method}`);
  });
  const dependencies: GuestAccountLifecycleDependencies = {
    getServerIdentity: () => identity,
    isServerIdentityCurrent: () => true,
    getCurrentAccountNumber: () => 1,
    getAccountUserId: async() => undefined,
    readCredentials: () => sessionStorage.get('guestCredentials', false),
    writeCredentials: async(records) => { await sessionStorage.set({guestCredentials: records}); },
    clearInvalidatedAccount: clearInvalidatedGuestAccount,
    withServerLock: async(_name, callback) => callback(),
    invokeApi,
    setUser: vi.fn(async() => {}),
    updatePasswordSettings: async() => true,
    verifyPassword: async() => true,
    signInWithPassword: async() => otherUser as any,
    subscribeInvalidation: () => () => {},
    ...overrides
  };
  return {lifecycle: createGuestAccountLifecycle(dependencies), invokeApi: dependencies.invokeApi, dependencies};
}

async function storeGuest() {
  await sessionStorage.set({
    guestCredentials: [savedRecord],
    account1: {userId: 42, dc1_auth_key: 'saved-auth-key'} as any
  });
}

beforeEach(async() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getTotalAccounts.mockResolvedValue(1);
  mocks.isUsingPasscode.mockResolvedValue(false);
  await sessionStorage.delete('guestCredentials');
  await sessionStorage.delete('account1');
});

afterEach(() => vi.unstubAllGlobals());

describe('invalidated guest account cleanup', () => {
  it('removes credentials, auth keys, account stores, and caches when the username is missing', async() => {
    await storeGuest();
    const {lifecycle, invokeApi} = createLifecycle({
      invokeApi: vi.fn(async(method: string) => {
        if(method === 'auth.sendCode') return {_: 'auth.authorizationSignUpRequired'};
        throw new Error('a missing username must not continue authentication');
      })
    });

    await expect(lifecycle.reauthenticate()).resolves.toEqual({kind: 'unrecoverable', username: savedRecord.username});

    expect(await sessionStorage.get('guestCredentials', false)).toBeUndefined();
    expect(await sessionStorage.get('account1', false)).toBeUndefined();
    expect(mocks.clearAccountStores).toHaveBeenCalledWith(1);
    expect(mocks.cacheDeleteAll).toHaveBeenCalledOnce();
    expect((invokeApi as any).mock.calls.map(([method]: [string]) => method)).toEqual(['auth.sendCode']);
  });

  it('removes the old account after username reuse returns a different user', async() => {
    await storeGuest();
    const {lifecycle, dependencies} = createLifecycle();

    await expect(lifecycle.reauthenticate()).resolves.toEqual({kind: 'unrecoverable', username: savedRecord.username});

    expect(dependencies.setUser).not.toHaveBeenCalled();
    expect(await sessionStorage.get('guestCredentials', false)).toBeUndefined();
    expect(await sessionStorage.get('account1', false)).toBeUndefined();
    expect(mocks.clearAccountStores).toHaveBeenCalledWith(1);
    expect(mocks.cacheDeleteAll).toHaveBeenCalledOnce();
  });

  it('clears the invalid account after SRP rejects the saved password', async() => {
    await storeGuest();
    const {lifecycle} = createLifecycle({
      signInWithPassword: async() => { throw {type: 'PASSWORD_HASH_INVALID'}; }
    });

    await expect(lifecycle.reauthenticate()).resolves.toEqual({kind: 'unrecoverable', username: savedRecord.username});

    expect(await sessionStorage.get('guestCredentials', false)).toBeUndefined();
    expect(await sessionStorage.get('account1', false)).toBeUndefined();
    expect(mocks.cacheDeleteAll).toHaveBeenCalledOnce();
  });

  it('preserves credentials and account state when SRP fails due to transport', async() => {
    await storeGuest();
    const {lifecycle} = createLifecycle({
      signInWithPassword: async() => { throw {type: 'NETWORK_ERROR'}; }
    });

    await expect(lifecycle.reauthenticate()).resolves.toEqual({kind: 'error', errorType: 'NETWORK_ERROR'});

    expect(await sessionStorage.get('guestCredentials', false)).toEqual([savedRecord]);
    expect(await sessionStorage.get('account1', false)).toMatchObject({userId: 42, dc1_auth_key: 'saved-auth-key'});
    expect(mocks.clearAccountStores).not.toHaveBeenCalled();
    expect(mocks.cacheDeleteAll).not.toHaveBeenCalled();
  });
});
