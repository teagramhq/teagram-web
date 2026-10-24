import {afterEach, describe, expect, it, vi} from 'vitest';

import {ApiManager} from '@appManagers/apiManager';
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
    rootScope: {myId: userId},
    log: {error: vi.fn()}
  });
  vi.spyOn(manager, 'getNetworker').mockResolvedValue(networker);
  vi.spyOn(manager, 'logOut').mockResolvedValue(undefined);
  vi.spyOn(manager as any, 'isNetworkerCurrentForDc').mockReturnValue(isCurrent);

  return {manager, networker};
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unknown auth keys for signed-in accounts', () => {
  it('logs out when the current networker reports an unknown auth key', async() => {
    const {manager} = createManager({code: -404, type: 'AUTH_KEY_UNKNOWN'}, 42);

    await expect((manager.invokeApi as any)('test.method', {}, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({code: -404, type: 'AUTH_KEY_UNKNOWN'});

    expect(manager.logOut).toHaveBeenCalledOnce();
  });

  it('does not log out an unbound account', async() => {
    const {manager} = createManager({code: -404, type: 'AUTH_KEY_UNKNOWN'}, 0);

    await expect((manager.invokeApi as any)('test.method', {}, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({code: -404, type: 'AUTH_KEY_UNKNOWN'});

    expect(manager.logOut).not.toHaveBeenCalled();
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

    await expect((manager.invokeApi as any)('test.method', {}, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({code: -429, type: 'AUTH_KEY_RATE_LIMIT'});

    expect(manager.logOut).not.toHaveBeenCalled();
  });
});
