import {afterEach, describe, expect, it, vi} from 'vitest';

import '@lib/crypto/crypto.worker';
import {ApiManager} from '@appManagers/apiManager';
import {PerformanceRpcTrace} from '@appManagers/performanceTrace';
import AccountController from '@lib/accounts/accountController';
import CryptoWorker from '@lib/crypto/cryptoMessagePort';
import bytesFromHex from '@helpers/bytes/bytesFromHex';
import * as guestAccountLocalCleanup from '@lib/guestAccountLocalCleanup';
import * as guestCredentialStorage from '@lib/guestCredentialStorage';
import {Authorizer} from '@lib/mtproto/authorizer';
import {MTAuthKey} from '@lib/mtproto/authKey';
import MTPNetworker from '@lib/mtproto/networker';
import rsaKeysManager from '@lib/mtproto/rsaKeysManager';
import Schema from '@lib/mtproto/schema';
import {TLDeserialization, TLSerialization} from '@lib/mtproto/tl_utils';
import {TimeManager} from '@lib/mtproto/timeManager';
import MTTransport from '@lib/mtproto/transports/transport';
import sessionStorage from '@lib/sessionStorage';

class SimulatedTransport {
  public networker?: MTPNetworker;
  public connected = true;
  public noScheduler?: boolean;
  public sentMethodIds: number[] = [];
  public destroy = vi.fn();

  public send(data: Uint8Array) {
    const requestBody = data.subarray(20);
    const deserializer = new TLDeserialization(requestBody, {mtproto: true});
    this.sentMethodIds.push(deserializer.fetchInt());
    const nonce = requestBody.subarray(4, 20).slice();

    const responseBody = new TLSerialization({mtproto: true});
    responseBody.storeObject({
      _: 'resPQ',
      nonce,
      server_nonce: new Uint8Array(16).fill(this.sentMethodIds.length),
      pq: new Uint8Array([0x17, 0x11]),
      server_public_key_fingerprints: ['123456789']
    }, 'ResPQ');

    const response = new TLSerialization({mtproto: true});
    response.storeLongP(0, 0, 'auth_key_id');
    response.storeLongP(0, 4, 'msg_id');
    response.storeInt(responseBody.getOffset(), 'msg_len');
    response.storeRawBytes(responseBody.getBytes(true));
    return Promise.resolve(response.getBytes(true));
  }

  public receiveResponse(packet: Uint8Array) {
    if(packet.byteLength !== 4 || !this.networker) return;
    const code = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getInt32(0, true);
    if(code < 0) this.networker.onTransportError(code, this as unknown as MTTransport);
  }
}

function makeTransportErrorPacket(code: number) {
  const packet = new Uint8Array(4);
  new DataView(packet.buffer).setInt32(0, code, true);
  return packet;
}

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
  (ApiManager as any).fillTimeManagerOffsetPromise = undefined;
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

  it('recovers a current idle networker when its transport reports an unknown auth key', () => {
    const {manager, networker: requestNetworker} = createManager({code: -404, type: 'AUTH_KEY_UNKNOWN'}, 0);
    const transport = requestNetworker.transport;
    const recoverUnknownAuthKey = vi.spyOn(manager, 'recoverUnknownAuthKey').mockResolvedValue(true);
    const targets = new Map();
    Object.assign(manager, {authKeyRecoveryTargets: targets, nextAuthKeyRecoveryId: 0});
    const networker = Object.create(MTPNetworker.prototype) as MTPNetworker;
    Object.assign(networker, {
      dcId: 2,
      transport,
      activeRequests: 0,
      isCurrentForDc: () => true,
      onAuthKeyUnknown: (source: MTPNetworker, failedTransport: MTTransport) => {
        (manager as any).handleIdleNetworkerAuthKeyUnknown(source, failedTransport);
      },
      sentMessages: {},
      log: vi.fn(),
      clearNextReq: vi.fn(),
      pendingMessages: {},
      pendingAcks: [],
      pendingResendReq: [],
      sentResendReq: new Map()
    });

    (networker as any).onTransportError(-404, transport);
    (networker as any).onTransportError(-404, {} as MTTransport);
    networker.activeRequests = 1;
    (networker as any).onTransportError(-404, transport);
    (networker as any).onTransportError(-429, transport);

    expect(recoverUnknownAuthKey).toHaveBeenCalledOnce();
    expect(recoverUnknownAuthKey).toHaveBeenCalledWith(1);
    expect(targets.get(1)).toEqual({networker, transport});
  });

  it('locally reauthenticates a bound account after repeated idle unknown-key errors', async() => {
    const {manager, networker: requestNetworker} = createManager({code: -404, type: 'AUTH_KEY_UNKNOWN'}, 42);
    const transport = requestNetworker.transport;
    let accountData: Record<string, unknown> = {
      userId: 42,
      dc2_auth_key: 'aa'.repeat(256),
      dc2_server_salt: '11'.repeat(8)
    };
    const dispatchEvent = vi.fn();
    Object.assign(manager, {accountNumber: 1, baseDcId: 2, rootScope: {myId: 42, dispatchEvent}});
    vi.spyOn(AccountController, 'getTotalAccounts').mockResolvedValue(1);
    vi.spyOn(AccountController, 'get').mockImplementation(async() => structuredClone(accountData) as any);
    vi.spyOn(guestCredentialStorage, 'clearGuestCredentialsForAccount').mockResolvedValue(undefined);
    const clearLocalState = vi.spyOn(guestAccountLocalCleanup, 'clearGuestAccountLocalState').mockImplementation(async() => {
      accountData = {};
    });
    const invokeApi = vi.spyOn(manager, 'invokeApi').mockResolvedValue(undefined as any);
    const recoverUnknownAuthKey = vi.spyOn(manager, 'recoverUnknownAuthKey');
    Object.assign(manager, {authKeyRecoveryTargets: new Map(), nextAuthKeyRecoveryId: 0});
    let isCurrent = true;
    vi.spyOn(manager as any, 'isNetworkerCurrentForDc').mockImplementation(() => isCurrent);
    const drainNetworker = vi.spyOn(manager as any, 'onNetworkerDrain').mockImplementation(() => {
      isCurrent = false;
    });
    const networker = Object.create(MTPNetworker.prototype) as MTPNetworker;
    Object.assign(networker, {
      dcId: 2,
      transport,
      activeRequests: 0,
      isCurrentForDc: () => true,
      onAuthKeyUnknown: (source: MTPNetworker, failedTransport: MTTransport) => {
        (manager as any).handleIdleNetworkerAuthKeyUnknown(source, failedTransport);
      },
      sentMessages: {},
      log: vi.fn(),
      clearNextReq: vi.fn(),
      pendingMessages: {},
      pendingAcks: [],
      pendingResendReq: [],
      sentResendReq: new Map()
    });

    (networker as any).onTransportError(-404, transport);
    await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledWith('logging_out', {accountNumber: 1}));
    (networker as any).onTransportError(-404, transport);

    expect(drainNetworker).toHaveBeenCalledOnce();
    expect(drainNetworker).toHaveBeenCalledWith(networker);
    expect(manager.logOut).not.toHaveBeenCalled();
    expect(invokeApi).not.toHaveBeenCalled();
    expect(recoverUnknownAuthKey).not.toHaveBeenCalled();
    expect(accountData).toEqual({});
    expect(clearLocalState).toHaveBeenCalledOnce();
    expect(clearLocalState).toHaveBeenCalledWith(1, 1, undefined);
    expect(guestCredentialStorage.clearGuestCredentialsForAccount).toHaveBeenCalledWith(42, 1, false);
  });

  it('retries local reauthentication after bound-account cleanup fails', async() => {
    const {manager} = createManager({code: -404, type: 'AUTH_KEY_UNKNOWN'}, 42);
    let accountData: Record<string, unknown> = {
      userId: 42,
      dc2_auth_key: 'aa'.repeat(256),
      dc2_server_salt: '11'.repeat(8)
    };
    const dispatchEvent = vi.fn();
    Object.assign(manager, {accountNumber: 1, baseDcId: 2, rootScope: {myId: 42, dispatchEvent}});
    vi.spyOn(AccountController, 'getTotalAccounts').mockResolvedValue(1);
    vi.spyOn(AccountController, 'get').mockImplementation(async() => structuredClone(accountData) as any);
    vi.spyOn(guestCredentialStorage, 'clearGuestCredentialsForAccount').mockResolvedValue(undefined);
    const cleanupError = new Error('local cleanup failed');
    let cleanupAttempts = 0;
    const clearLocalState = vi.spyOn(guestAccountLocalCleanup, 'clearGuestAccountLocalState').mockImplementation(async() => {
      cleanupAttempts++;
      if(cleanupAttempts === 1) throw cleanupError;
      accountData = {};
    });
    const invokeApi = vi.spyOn(manager, 'invokeApi').mockResolvedValue(undefined as any);
    Object.assign(manager, {authKeyRecoveryTargets: new Map(), nextAuthKeyRecoveryId: 0});

    let currentNetworker: MTPNetworker | undefined;
    const isCurrentForDc = vi.spyOn(manager as any, 'isNetworkerCurrentForDc').mockImplementation((dcId, networker) => {
      return networker === currentNetworker;
    });
    const drainNetworker = vi.spyOn(manager as any, 'onNetworkerDrain').mockImplementation((networker) => {
      if(currentNetworker === networker) currentNetworker = undefined;
    });
    const createIdleNetworker = (transport: MTTransport) => {
      const networker = Object.create(MTPNetworker.prototype) as MTPNetworker;
      Object.assign(networker, {
        dcId: 2,
        transport,
        activeRequests: 0,
        isCurrentForDc: () => currentNetworker === networker,
        onAuthKeyUnknown: (source: MTPNetworker, failedTransport: MTTransport) => {
          (manager as any).handleIdleNetworkerAuthKeyUnknown(source, failedTransport);
        },
        sentMessages: {},
        log: vi.fn(),
        clearNextReq: vi.fn(),
        pendingMessages: {},
        pendingAcks: [],
        pendingResendReq: [],
        sentResendReq: new Map()
      });
      return networker;
    };

    const firstTransport = {} as MTTransport;
    const firstNetworker = createIdleNetworker(firstTransport);
    currentNetworker = firstNetworker;
    (firstNetworker as any).onTransportError(-404, firstTransport);
    await vi.waitFor(() => expect((manager as any).log.error).toHaveBeenCalledWith(
      'Failed to clear rejected auth session locally',
      cleanupError
    ));

    const secondTransport = {} as MTTransport;
    const secondNetworker = createIdleNetworker(secondTransport);
    currentNetworker = secondNetworker;
    (secondNetworker as any).onTransportError(-404, secondTransport);
    await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledWith('logging_out', {accountNumber: 1}));

    expect(isCurrentForDc).toHaveBeenCalled();
    expect(drainNetworker).toHaveBeenCalledTimes(2);
    expect(clearLocalState).toHaveBeenCalledTimes(2);
    expect(accountData).toEqual({});
    expect(manager.logOut).not.toHaveBeenCalled();
    expect(invokeApi).not.toHaveBeenCalled();
  });

  it('uses the production networker wiring to send req_pq after repeated idle WebSocket rejections', async() => {
    vi.stubGlobal('navigator', {...navigator, locks: {request: (_name: string, callback: () => Promise<unknown>) => callback()}});
    const rejectedKey = 'aa'.repeat(256);
    const firstReplacementKey = 'bb'.repeat(256);
    const secondReplacementKey = 'cc'.repeat(256);
    let accountData: Record<string, any> = {
      dc2_auth_key: rejectedKey,
      dc2_server_salt: '11'.repeat(8)
    };
    const getAccount = vi.spyOn(AccountController, 'get').mockImplementation(async() => structuredClone(accountData));
    vi.spyOn(sessionStorage, 'getFresh').mockImplementation(async(key: string) => {
      return key === 'account1' ? structuredClone(accountData) : undefined;
    });
    vi.spyOn(sessionStorage, 'set').mockImplementation(async(data: any) => {
      if(data.account1) accountData = structuredClone(data.account1);
    });
    vi.spyOn(sessionStorage, 'flush').mockResolvedValue(undefined);
    vi.spyOn(AccountController, 'updateStorageForLegacy').mockResolvedValue(undefined);
    (ApiManager as any).fillTimeManagerOffsetPromise = Promise.resolve();

    const timeManager = new TimeManager();
    const transports: SimulatedTransport[] = [];
    const dcConfigurator = {
      chosenServers: {
        http: {client: {}, download: {}, upload: {}},
        https: {client: {}, download: {}, upload: {}},
        websocket: {client: {}, download: {}, upload: {}}
      },
      chooseServer: vi.fn(() => {
        const transport = new SimulatedTransport();
        transports.push(transport);
        return transport as unknown as MTTransport;
      })
    };
    const authorizer = new Authorizer({timeManager, dcConfigurator: dcConfigurator as any});
    (authorizer as any).transportType = 'websocket';
    (authorizer as any).getTransportTypePromise = Promise.resolve();

    const temporaryAuth = {
      authKey: new MTAuthKey(new Uint8Array(256).fill(0xdd), new Uint8Array(8).fill(1)),
      serverSalt: new Uint8Array(8).fill(0x44),
      expiresAt: Date.now() + 60_000
    };
    const originalAuth = authorizer.auth.bind(authorizer);
    const auth = vi.spyOn(authorizer, 'auth').mockImplementation((dcId, temp, force) => {
      if(temp) return Promise.resolve(temporaryAuth as any);
      return originalAuth(dcId, temp, force);
    });
    const exchangeKeys = [
      {key: firstReplacementKey, byte: 0xbb, salt: 0x22},
      {key: secondReplacementKey, byte: 0xcc, salt: 0x33}
    ];
    let exchangeCount = 0;
    vi.spyOn(authorizer as any, 'sendReqDhParams').mockImplementation(async(authOptions: any) => {
      const exchange = exchangeKeys[exchangeCount++];
      return {
        ...authOptions,
        authKey: new MTAuthKey(new Uint8Array(256).fill(exchange.byte), new Uint8Array(8).fill(exchange.byte)),
        serverSalt: new Uint8Array(8).fill(exchange.salt)
      };
    });
    vi.spyOn(rsaKeysManager, 'prepare').mockResolvedValue(undefined);
    vi.spyOn(rsaKeysManager, 'select').mockResolvedValue({
      modulus: 'f'.repeat(512),
      exponent: '010001',
      fingerprint: '123456789'
    });
    vi.spyOn(CryptoWorker, 'invokeCrypto').mockResolvedValue([new Uint8Array([3]), new Uint8Array([5])] as any);

    const networkers: MTPNetworker[] = [];
    const networkerFactory = {
      getNetworker: vi.fn((options: any) => {
        const networker = new MTPNetworker({
          ...options,
          timeManager,
          getInitConnectionParams: () => ({id: 1}),
          getBaseDcId: async() => 2
        } as any);
        networkers.push(networker);
        return networker;
      }),
      removeNetworker: vi.fn()
    };
    const cachedNetworkers: any = Object.fromEntries(['http', 'https', 'websocket'].map((transportType) => [transportType, {
      client: {},
      download: {},
      upload: {}
    }]));
    const log = Object.assign(vi.fn(), {error: vi.fn()});
    const manager = Object.create(ApiManager.prototype) as ApiManager;
    Object.assign(manager, {
      accountNumber: 1,
      authKeyRecoveryTargets: new Map(),
      nextAuthKeyRecoveryId: 0,
      baseDcId: 2,
      cachedNetworkers,
      gettingNetworkers: {},
      transportType: 'websocket',
      timeManager,
      rootScope: {myId: 0, premium: false},
      dcConfigurator,
      networkerFactory,
      authorizer,
      performanceRpcTrace: new PerformanceRpcTrace(false),
      log
    });
    vi.spyOn(manager, 'getAuthKeyFromHex').mockImplementation(async(authKeyHex) => {
      return new MTAuthKey(bytesFromHex(authKeyHex), new Uint8Array(8));
    });
    vi.spyOn(manager, 'setOnDrainIfNeeded').mockImplementation(() => {});
    const recover = vi.spyOn(manager, 'recoverUnknownAuthKey');

    const firstNetworker = await manager.getNetworker(2);
    expect(firstNetworker.usesPermanentAuthKeyHex(rejectedKey)).toBe(true);
    (firstNetworker.transport as unknown as SimulatedTransport).receiveResponse(makeTransportErrorPacket(-404));
    await expect(recover.mock.results[0].value).resolves.toBe(true);

    const secondNetworker = await manager.getNetworker(2);
    expect(accountData.dc2_auth_key).toBe(firstReplacementKey);
    expect(secondNetworker.usesPermanentAuthKeyHex(firstReplacementKey)).toBe(true);
    expect(secondNetworker.usesPermanentAuthKeyHex(rejectedKey)).toBe(false);
    (secondNetworker.transport as unknown as SimulatedTransport).receiveResponse(makeTransportErrorPacket(-404));
    await expect(recover.mock.results[1].value).resolves.toBe(true);

    const reqPqMethodId = Schema.MTProto.methods.find(({method}) => method === 'req_pq_multi')!.id;
    expect(transports.filter(({sentMethodIds}) => sentMethodIds.length).map(({sentMethodIds}) => sentMethodIds))
    .toEqual([[reqPqMethodId], [reqPqMethodId]]);
    expect(accountData.dc2_auth_key).toBe(secondReplacementKey);
    expect(auth).toHaveBeenCalledWith(2, false, true);
    expect(auth.mock.calls.filter(([, temp]) => !temp)).toHaveLength(2);
    expect(networkers).toHaveLength(2);
    expect(getAccount).toHaveBeenCalledTimes(2);
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
