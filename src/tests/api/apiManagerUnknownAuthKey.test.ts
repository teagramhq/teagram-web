import {afterEach, describe, expect, it, vi} from 'vitest';

import {ApiManager} from '@appManagers/apiManager';
import {PerformanceRpcTrace} from '@appManagers/performanceTrace';
import MTPNetworker from '@lib/mtproto/networker';
import MTTransport from '@lib/mtproto/transports/transport';

function createManager(error: {code: number, type: string}, userId: number, isCurrent = true) {
  const transport = {} as MTTransport;
  let networkerTransport = transport;
  const networker = {
    dcId: 2,
    get transport() {
      return networkerTransport;
    },
    set transport(value: MTTransport) {
      networkerTransport = value;
    },
    wrapApiCall: vi.fn().mockRejectedValue(error),
    attachPromise: vi.fn()
  } as unknown as MTPNetworker;
  const manager = Object.create(ApiManager.prototype) as ApiManager;
  Object.assign(manager, {
    accountNumber: 1,
    baseDcId: 2,
    performanceRpcTrace: new PerformanceRpcTrace(false),
    rootScope: {myId: userId},
    log: {error: vi.fn()}
  });
  vi.spyOn(manager, 'getNetworker').mockResolvedValue(networker);
  vi.spyOn(manager, 'logOut').mockResolvedValue(undefined);
  vi.spyOn(manager as any, 'isNetworkerCurrentForDc').mockReturnValue(isCurrent);

  return {manager, networker};
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('unknown auth keys', () => {
  it('logs out when the current networker reports an unknown auth key', async() => {
    const {manager} = createManager({code: -404, type: 'AUTH_KEY_UNKNOWN'}, 42);

    await expect((manager.invokeApi as any)('test.method', {}, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({code: -404, type: 'AUTH_KEY_UNKNOWN'});

    expect(manager.logOut).toHaveBeenCalledOnce();
  });

  it('exchanges a rejected stored key once for concurrent unknown-key errors on an unbound account', async() => {
    const queues = new Map<string, Promise<void>>();
    const request = async(name: string, callback: () => Promise<unknown>) => {
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
    };
    vi.stubGlobal('navigator', {...navigator, locks: {request}});

    const rejectedKey = 'aa'.repeat(256);
    const replacementKey = 'bb'.repeat(256);
    const replacementSalt = '22'.repeat(8);
    const accountData: Record<string, unknown> = {
      dc2_auth_key: rejectedKey,
      dc2_server_salt: '11'.repeat(8)
    };
    const {manager, networker} = createManager({code: -404, type: 'AUTH_KEY_UNKNOWN'}, 0);
    Object.assign(networker, {
      dcId: 2,
      permAuthKey: {key: new Uint8Array(256).fill(0xaa)},
      usesPermanentAuthKeyHex: (authKeyHex: string) => authKeyHex.toLowerCase() === rejectedKey
    });

    let isCurrent = true;
    vi.spyOn(manager as any, 'isNetworkerCurrentForDc').mockImplementation(() => isCurrent);
    const invalidateNetworkers = vi.spyOn(manager as any, 'invalidateNetworkersForAuthKey').mockImplementation(() => {
      isCurrent = false;
    });
    const readAccountData = vi.spyOn(manager as any, 'readAccountData').mockImplementation(async() => structuredClone(accountData));
    const writeAuthKeyData = vi.spyOn(manager as any, 'writeAuthKeyData').mockImplementation(async(...args: unknown[]) => {
      const [, dcIdValue, authKeyHex, serverSaltHex] = args;
      const dcId = Number(dcIdValue);
      const authKeyName = `dc${dcId}_auth_key`;
      const serverSaltName = `dc${dcId}_server_salt`;
      if(typeof authKeyHex === 'string') {
        accountData[authKeyName] = authKeyHex;
        if(typeof serverSaltHex === 'string') accountData[serverSaltName] = serverSaltHex;
      } else {
        delete accountData[authKeyName];
        delete accountData[serverSaltName];
      }
      return true;
    });
    const auth = vi.fn(async() => ({
      authKey: {key: new Uint8Array(256).fill(0xbb)},
      serverSalt: new Uint8Array(8).fill(0x22)
    }));
    Object.assign(manager, {authorizer: {auth}});

    const results = await Promise.all([
      (manager.invokeApi as any)('test.method', {}, {dcId: 2, ignoreErrors: true}),
      (manager.invokeApi as any)('test.method', {}, {dcId: 2, ignoreErrors: true})
    ].map((request) => request.then(
      () => ({status: 'fulfilled'}),
      (reason: unknown) => ({status: 'rejected', reason})
    )));

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(results.map((result) => result.status === 'rejected' ? result.reason : undefined)).toMatchObject([
      {code: -404, type: 'AUTH_KEY_UNKNOWN'},
      {code: -404, type: 'AUTH_KEY_UNKNOWN'}
    ]);
    expect(manager.logOut).not.toHaveBeenCalled();
    expect(auth).toHaveBeenCalledOnce();
    expect(auth).toHaveBeenCalledWith(2, false, true);
    expect(readAccountData).toHaveBeenCalled();
    expect(writeAuthKeyData).toHaveBeenCalledTimes(2);
    expect(accountData).toEqual({dc2_auth_key: replacementKey, dc2_server_salt: replacementSalt});
    expect(invalidateNetworkers).toHaveBeenCalledOnce();
  });

  it('ignores an unknown-key error from a stale networker', async() => {
    const {manager} = createManager({code: -404, type: 'AUTH_KEY_UNKNOWN'}, 42, false);

    await expect((manager.invokeApi as any)('test.method', {}, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({code: -404, type: 'AUTH_KEY_UNKNOWN'});

    expect(manager.logOut).not.toHaveBeenCalled();
  });

  it('ignores an unknown-key error after the connection is superseded', async() => {
    const {manager, networker} = createManager({code: -404, type: 'AUTH_KEY_UNKNOWN'}, 42);
    const replacementTransport = {} as MTTransport;
    vi.mocked(networker.wrapApiCall).mockImplementation(() => {
      networker.transport = replacementTransport;
      return Promise.reject({code: -404, type: 'AUTH_KEY_UNKNOWN'});
    });

    await expect((manager.invokeApi as any)('test.method', {}, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({code: -404, type: 'AUTH_KEY_UNKNOWN'});

    expect(manager.logOut).not.toHaveBeenCalled();
  });

  it('does not log out for other transport errors', async() => {
    const {manager} = createManager({code: -429, type: 'AUTH_KEY_RATE_LIMIT'}, 42);
    const recover = vi.spyOn(manager, 'recoverUnknownAuthKey').mockResolvedValue(true);

    await expect((manager.invokeApi as any)('test.method', {}, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({code: -429, type: 'AUTH_KEY_RATE_LIMIT'});

    expect(manager.logOut).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });
});
