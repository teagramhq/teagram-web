import {afterEach, describe, expect, it, vi} from 'vitest';

import {ApiManager} from '@appManagers/apiManager';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import AccountController from '@lib/accounts/accountController';
import {recoverRejectedAuthKey} from '@lib/mtproto/authKeyRecovery';
import MTPNetworker from '@lib/mtproto/networker';
import sessionStorage from '@lib/sessionStorage';
import deferredPromise from '@helpers/cancellablePromise';

const REJECTED_KEY = 'aa'.repeat(256);
const REPLACEMENT_KEY = 'bb'.repeat(256);
const SERVER_SALT = '1234567890abcdef';

function installLocks() {
  const queues = new Map<string, Promise<void>>();
  const request = vi.fn(async(name: string, callback: () => Promise<unknown>) => {
    const previous = queues.get(name) || Promise.resolve();
    let release: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    queues.set(name, previous.then(() => current));
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  });
  vi.stubGlobal('navigator', {...navigator, locks: {request}});
  return request;
}

function createStorage(initialData: Record<string, unknown>, prefix: string) {
  const records = new Map<string, Record<string, unknown>>([
    ['account1', {dc2_auth_key: 'default-server-key'}],
    [`${prefix}account1`, initialData]
  ]);
  const readAccount = vi.fn(async() => structuredClone(records.get(`${prefix}account1`)));
  const writeAccount = vi.fn(async(data: Record<string, unknown>) => {
    records.set(`${prefix}account1`, structuredClone(data));
  });
  return {records, readAccount, writeAccount};
}

function makeRecoveryOptions(overrides: Record<string, unknown> = {}) {
  const storage = createStorage({dc2_auth_key: REJECTED_KEY, dc2_server_salt: 'old-salt'}, 'teagram-custom-');
  const exchangeAuthKey = vi.fn(async() => ({authKeyHex: REPLACEMENT_KEY, serverSaltHex: SERVER_SALT}));
  const invalidateRejectedKey = vi.fn();
  return {
    accountNumber: 1 as ActiveAccountNumber,
    dcId: 2,
    isRejectedAuthKey: (authKeyHex: string) => authKeyHex.toLowerCase() === REJECTED_KEY,
    isNetworkerCurrent: () => true,
    readAccount: storage.readAccount,
    writeAccount: storage.writeAccount,
    exchangeAuthKey,
    invalidateRejectedKey,
    storage,
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as any).__TEAGRAM_ACTIVE_SERVER_ID__;
});

describe('unknown auth-key recovery', () => {
  it('serializes by server storage prefix, account and DC', async() => {
    const serverId = `custom-${'c'.repeat(64)}`;
    (globalThis as any).__TEAGRAM_ACTIVE_SERVER_ID__ = serverId;
    const request = installLocks();
    const options = makeRecoveryOptions();

    await recoverRejectedAuthKey(options);

    expect(request.mock.calls[0][0]).toBe(`teagram-${serverId}:auth-key-recovery:1:2`);
  });

  it('clears and replaces only the rejected key and salt under the active server prefix', async() => {
    const serverId = `custom-${'a'.repeat(64)}`;
    (globalThis as any).__TEAGRAM_ACTIVE_SERVER_ID__ = serverId;
    installLocks();
    const prefix = `teagram-${serverId}:`;
    const options = makeRecoveryOptions();
    const storage = createStorage({
      userId: undefined,
      dc2_auth_key: REJECTED_KEY,
      dc2_server_salt: 'old-salt',
      dc3_auth_key: 'other-dc-key'
    }, prefix);
    Object.assign(options, storage);

    await expect(recoverRejectedAuthKey(options)).resolves.toBe(true);

    expect(storage.records.get(`${prefix}account1`)).toEqual({
      userId: undefined,
      dc2_auth_key: REPLACEMENT_KEY,
      dc2_server_salt: SERVER_SALT,
      dc3_auth_key: 'other-dc-key'
    });
    expect(storage.records.get('account1')).toEqual({dc2_auth_key: 'default-server-key'});
    expect(options.exchangeAuthKey).toHaveBeenCalledOnce();
    expect(options.invalidateRejectedKey).toHaveBeenCalledOnce();
  });

  it('makes a concurrent manager adopt the first manager replacement without another exchange', async() => {
    installLocks();
    const storage = createStorage({dc2_auth_key: REJECTED_KEY, dc2_server_salt: 'old-salt'}, 'teagram-custom-');
    let enterExchange: () => void;
    let releaseExchange: () => void;
    const enteredExchange = new Promise<void>((resolve) => { enterExchange = resolve; });
    const exchangeGate = new Promise<void>((resolve) => { releaseExchange = resolve; });
    const firstOptions = makeRecoveryOptions({
      ...storage,
      exchangeAuthKey: vi.fn(async() => {
        enterExchange();
        await exchangeGate;
        return {authKeyHex: REPLACEMENT_KEY, serverSaltHex: SERVER_SALT};
      })
    });
    const secondOptions = makeRecoveryOptions({
      ...storage,
      exchangeAuthKey: vi.fn(async() => ({authKeyHex: 'cc'.repeat(256), serverSaltHex: SERVER_SALT}))
    });

    const first = recoverRejectedAuthKey(firstOptions);
    await enteredExchange;
    const second = recoverRejectedAuthKey(secondOptions);
    releaseExchange();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(firstOptions.exchangeAuthKey).toHaveBeenCalledOnce();
    expect(secondOptions.exchangeAuthKey).not.toHaveBeenCalled();
    expect(storage.records.get('teagram-custom-account1')?.dc2_auth_key).toBe(REPLACEMENT_KEY);
  });

  it('does not overwrite a key another manager already stored', async() => {
    installLocks();
    const options = makeRecoveryOptions({
      readAccount: vi.fn(async() => ({dc2_auth_key: REPLACEMENT_KEY, dc2_server_salt: SERVER_SALT})),
      writeAccount: vi.fn()
    });

    await expect(recoverRejectedAuthKey(options)).resolves.toBe(true);

    expect(options.writeAccount).not.toHaveBeenCalled();
    expect(options.exchangeAuthKey).not.toHaveBeenCalled();
    expect(options.invalidateRejectedKey).toHaveBeenCalledOnce();
  });

  it('adopts a newer key without invalidating from a stale networker', async() => {
    installLocks();
    const invalidateRejectedKey = vi.fn();
    const options = makeRecoveryOptions({
      isNetworkerCurrent: () => false,
      readAccount: vi.fn(async() => ({dc2_auth_key: REPLACEMENT_KEY, dc2_server_salt: SERVER_SALT})),
      writeAccount: vi.fn(),
      invalidateRejectedKey
    });

    await expect(recoverRejectedAuthKey(options)).resolves.toBe(true);

    expect(options.writeAccount).not.toHaveBeenCalled();
    expect(options.exchangeAuthKey).not.toHaveBeenCalled();
    expect(invalidateRejectedKey).not.toHaveBeenCalled();
  });

  it('does nothing for a stale networker while the rejected key is still stored', async() => {
    installLocks();
    const options = makeRecoveryOptions({isNetworkerCurrent: () => false});

    await expect(recoverRejectedAuthKey(options)).resolves.toBe(false);

    expect(options.writeAccount).not.toHaveBeenCalled();
    expect(options.exchangeAuthKey).not.toHaveBeenCalled();
    expect(options.invalidateRejectedKey).not.toHaveBeenCalled();
  });

  it('never rekeys an account that became bound', async() => {
    installLocks();
    const options = makeRecoveryOptions({
      readAccount: vi.fn(async() => ({userId: 42, dc2_auth_key: REJECTED_KEY, dc2_server_salt: 'old-salt'}))
    });

    await expect(recoverRejectedAuthKey(options)).resolves.toBe(false);

    expect(options.writeAccount).not.toHaveBeenCalled();
    expect(options.exchangeAuthKey).not.toHaveBeenCalled();
  });

  it('serializes concurrent unknown-key responses from one manager and updates its fingerprint', async() => {
    installLocks();
    let accountData: Record<string, unknown> = {
      dc2_auth_key: REJECTED_KEY,
      dc2_server_salt: 'old-salt',
      auth_key_fingerprint: REJECTED_KEY.slice(0, 8)
    };
    const get = vi.spyOn(sessionStorage, 'getFresh').mockImplementation(async() => structuredClone(accountData) as any);
    const set = vi.spyOn(sessionStorage, 'set').mockImplementation(async(data: any) => {
      accountData = structuredClone(data.account1);
    });
    vi.spyOn(AccountController, 'updateStorageForLegacy').mockResolvedValue(undefined);

    const networker = Object.create(MTPNetworker.prototype) as MTPNetworker;
    const networkerFactory = {removeNetworker: vi.fn()};
    Object.assign(networker, {
      dcId: 2,
      permAuthKey: {key: new Uint8Array(256).fill(0xaa)},
      transport: {destroy: vi.fn()},
      changeTransport: vi.fn(function(this: MTPNetworker, transport) { this.transport = transport; }),
      destroy: vi.fn()
    });
    const authKey = new Uint8Array(256).fill(0xbb);
    const serverSalt = new Uint8Array(8).fill(0xcc);
    const auth = vi.fn(async() => ({authKey: {key: authKey}, serverSalt}));
    const manager = Object.create(ApiManager.prototype) as ApiManager;
    Object.assign(manager, {
      accountNumber: 1,
      authKeyRecoveryTargets: new Map([
        [17, {networker, transport: networker.transport}],
        [18, {networker, transport: networker.transport}]
      ]),
      cachedNetworkers: {websocket: {client: {2: [networker]}, download: {}, upload: {}}},
      dcConfigurator: {chosenServers: {}},
      networkerFactory,
      authorizer: {auth},
      log: vi.fn()
    });

    await expect(Promise.all([
      manager.recoverUnknownAuthKey(17),
      manager.recoverUnknownAuthKey(18)
    ])).resolves.toEqual([true, true]);

    expect(get).toHaveBeenNthCalledWith(1, 'account1');
    expect(get).toHaveBeenNthCalledWith(2, 'account1');
    expect(get).toHaveBeenNthCalledWith(3, 'account1');
    expect(auth).toHaveBeenCalledOnce();
    expect(auth).toHaveBeenCalledWith(2, false, true);
    expect(accountData).toMatchObject({
      dc2_auth_key: REPLACEMENT_KEY,
      dc2_server_salt: 'cccccccccccccccc',
      auth_key_fingerprint: 'bbbbbbbb'
    });
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[0][0].account1).not.toHaveProperty('auth_key_fingerprint');
    expect(networkerFactory.removeNetworker).toHaveBeenCalledWith(networker);
    expect((manager as any).cachedNetworkers.websocket.client[2]).toEqual([]);
  });

  it('merges concurrent DC recoveries with account updates', async() => {
    installLocks();
    let accountData: Record<string, unknown> = {
      dc2_auth_key: REJECTED_KEY,
      dc2_server_salt: 'old-salt-2',
      dc3_auth_key: 'cc'.repeat(256),
      dc3_server_salt: 'old-salt-3',
      auth_key_fingerprint: REJECTED_KEY.slice(0, 8),
      push_key: 'existing-push-key'
    };
    let holdExchangeReads = false;
    let heldExchangeReads = 0;
    let resolveHeldExchangeReads: () => void;
    let releaseHeldExchangeReads: () => void;
    const heldExchangeReadsReady = new Promise<void>((resolve) => { resolveHeldExchangeReads = resolve; });
    const heldExchangeReadsGate = new Promise<void>((resolve) => { releaseHeldExchangeReads = resolve; });
    let holdReplacementWrite = true;
    let resolveReplacementWriteStarted: () => void;
    let releaseReplacementWrite: () => void;
    const replacementWriteStarted = new Promise<void>((resolve) => { resolveReplacementWriteStarted = resolve; });
    const replacementWriteGate = new Promise<void>((resolve) => { releaseReplacementWrite = resolve; });
    vi.spyOn(sessionStorage, 'getFresh').mockImplementation(async() => {
      const snapshot = structuredClone(accountData);
      if(holdExchangeReads && heldExchangeReads < 2) {
        heldExchangeReads++;
        if(heldExchangeReads === 2) resolveHeldExchangeReads();
        await heldExchangeReadsGate;
      }
      return snapshot as any;
    });
    vi.spyOn(sessionStorage, 'get').mockImplementation(async(key: any) => {
      return key === 'account1' ? structuredClone(accountData) as any : {} as any;
    });
    vi.spyOn(sessionStorage, 'set').mockImplementation(async(data: any) => {
      const account = data.account1;
      if(holdReplacementWrite && account && (account.dc2_auth_key === '11'.repeat(256) || account.dc3_auth_key === '33'.repeat(256))) {
        holdReplacementWrite = false;
        resolveReplacementWriteStarted();
        await replacementWriteGate;
      }
      if(data.account1) accountData = structuredClone(data.account1);
    });
    vi.spyOn(AccountController, 'updateStorageForLegacy').mockResolvedValue(undefined);

    const makeNetworker = (dcId: number, keyByte: number) => {
      const networker = Object.create(MTPNetworker.prototype) as MTPNetworker;
      const transport = {destroy: vi.fn()};
      Object.assign(networker, {
        dcId,
        permAuthKey: {key: new Uint8Array(256).fill(keyByte)},
        transport,
        changeTransport: vi.fn(function(this: MTPNetworker, nextTransport) { this.transport = nextTransport; }),
        destroy: vi.fn()
      });
      return networker;
    };
    const networker2 = makeNetworker(2, 0xaa);
    const networker3 = makeNetworker(3, 0xcc);
    let exchangesStarted = 0;
    let resolveExchangesStarted: () => void;
    let releaseExchanges: () => void;
    const exchangesReady = new Promise<void>((resolve) => { resolveExchangesStarted = resolve; });
    const exchangeGate = new Promise<void>((resolve) => { releaseExchanges = resolve; });
    const authorizer = {
      auth: vi.fn(async(dcId: number) => {
        exchangesStarted++;
        if(exchangesStarted === 2) resolveExchangesStarted();
        await exchangeGate;
        return {
          authKey: {key: new Uint8Array(256).fill(dcId === 2 ? 0x11 : 0x33)},
          serverSalt: new Uint8Array(8).fill(dcId === 2 ? 0x22 : 0x44)
        };
      })
    };
    const manager = Object.create(ApiManager.prototype) as ApiManager;
    Object.assign(manager, {
      accountNumber: 1,
      authKeyRecoveryTargets: new Map([
        [17, {networker: networker2, transport: networker2.transport}],
        [18, {networker: networker3, transport: networker3.transport}]
      ]),
      cachedNetworkers: {websocket: {client: {2: [networker2], 3: [networker3]}, download: {}, upload: {}}},
      dcConfigurator: {chosenServers: {}},
      networkerFactory: {removeNetworker: vi.fn()},
      authorizer,
      log: vi.fn()
    });

    const recoveries = Promise.all([
      manager.recoverUnknownAuthKey(17),
      manager.recoverUnknownAuthKey(18)
    ]);
    await exchangesReady;
    holdExchangeReads = true;
    releaseExchanges();
    await heldExchangeReadsReady;
    releaseHeldExchangeReads();
    await replacementWriteStarted;
    const accountUpdate = AccountController.update(1, {userId: 42});
    releaseReplacementWrite();

    await expect(Promise.all([recoveries, accountUpdate])).resolves.toEqual([[true, true], expect.objectContaining({userId: 42})]);
    expect(accountData).toMatchObject({
      userId: 42,
      dc2_auth_key: '11'.repeat(256),
      dc2_server_salt: '22'.repeat(8),
      dc3_auth_key: '33'.repeat(256),
      dc3_server_salt: '44'.repeat(8)
    });
  });

  it('rejects pending RPCs on sibling networkers when retiring a rejected key', async() => {
    installLocks();
    let accountData: Record<string, unknown> = {
      dc2_auth_key: REJECTED_KEY,
      dc2_server_salt: 'old-salt',
      auth_key_fingerprint: REJECTED_KEY.slice(0, 8)
    };
    vi.spyOn(sessionStorage, 'getFresh').mockImplementation(async() => structuredClone(accountData) as any);
    vi.spyOn(sessionStorage, 'set').mockImplementation(async(data: any) => {
      if(data.account1) accountData = structuredClone(data.account1);
    });
    vi.spyOn(AccountController, 'updateStorageForLegacy').mockResolvedValue(undefined);

    const makeNetworker = () => {
      const networker = Object.create(MTPNetworker.prototype) as MTPNetworker;
      const transport = {destroy: vi.fn()};
      Object.assign(networker, {
        dcId: 2,
        permAuthKey: {key: new Uint8Array(256).fill(0xaa)},
        transport,
        changeTransport: vi.fn(function(this: MTPNetworker, nextTransport) { this.transport = nextTransport; }),
        destroy: vi.fn(),
        isCurrentForDc: () => true
      });
      return networker;
    };
    const rejectedNetworker = makeNetworker();
    const siblingNetworker = makeNetworker();
    const pendingRequest = deferredPromise<void>();
    Object.assign(siblingNetworker, {
      log: vi.fn(),
      sentMessages: {pending: {deferred: pendingRequest}},
      pendingMessages: {pending: 0},
      pendingAcks: [],
      pendingResendReq: [],
      sentResendReq: new Map(),
      clearNextReq: vi.fn(),
      scheduleRequest: vi.fn()
    });
    const manager = Object.create(ApiManager.prototype) as ApiManager;
    Object.assign(manager, {
      accountNumber: 1,
      authKeyRecoveryTargets: new Map([[17, {networker: rejectedNetworker, transport: rejectedNetworker.transport}]]),
      cachedNetworkers: {websocket: {client: {2: [rejectedNetworker, siblingNetworker]}, download: {}, upload: {}}},
      dcConfigurator: {chosenServers: {}},
      networkerFactory: {removeNetworker: vi.fn()},
      authorizer: {
        auth: vi.fn(async() => ({
          authKey: {key: new Uint8Array(256).fill(0xbb)},
          serverSalt: new Uint8Array(8).fill(0xcc)
        }))
      },
      log: vi.fn()
    });
    await expect(manager.recoverUnknownAuthKey(17)).resolves.toBe(true);

    expect(siblingNetworker.destroy).toHaveBeenCalledOnce();
    expect(siblingNetworker.scheduleRequest).not.toHaveBeenCalled();
    expect(pendingRequest.isRejected).toBe(true);
    await expect(pendingRequest).rejects.toMatchObject({type: 'AUTH_KEY_UNKNOWN', code: -404});
  });

  it('creates a missing permanent auth key when Web Locks are unavailable', async() => {
    vi.stubGlobal('navigator', {});
    const permanent = {
      authKey: {key: new Uint8Array(256).fill(0x12)},
      serverSalt: new Uint8Array(8).fill(0x34)
    };
    const readAccountData = vi.fn(async() => ({}));
    const writeAuthKeyData = vi.fn(async() => {});
    const auth = vi.fn(async() => permanent);
    const manager = Object.create(ApiManager.prototype) as ApiManager;
    Object.assign(manager, {
      readAccountData,
      writeAuthKeyData,
      authorizer: {auth}
    });

    await expect((manager as any).getOrCreatePermanentAuthKey(1, 2)).resolves.toBe(permanent);

    expect(auth).toHaveBeenCalledOnce();
    expect(auth).toHaveBeenCalledWith(2, false, true);
    expect(writeAuthKeyData).toHaveBeenCalledOnce();
  });
});
