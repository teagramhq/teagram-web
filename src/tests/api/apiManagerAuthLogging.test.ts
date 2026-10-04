import {afterEach, describe, expect, it, vi} from 'vitest';

import {ApiManager} from '@appManagers/apiManager';
import {ApiManager as BaseApiManager} from '../../lib/appManagers/apiManager';
import {clearLogBuffer, getLogEntries, isLogBufferEnabled, setLogBufferEnabled} from '@lib/debug/logsBuffer';
import {LogTypes, logger} from '@lib/logger';
import MTPNetworker from '@lib/mtproto/networker';

const AUTH_METHODS = ['auth.sendCode', 'auth.signIn', 'auth.checkPassword'] as const;

function createPrivateManager(networker: Pick<MTPNetworker, 'wrapApiCall' | 'attachPromise'>) {
  const logError = vi.fn();
  const manager = Object.create(ApiManager.prototype) as ApiManager;
  Object.assign(manager, {
    baseDcId: 2,
    log: {error: logError}
  });
  vi.spyOn(BaseApiManager.prototype, 'getNetworker').mockResolvedValue(networker as MTPNetworker);
  return {manager, logError};
}

function createNetworkerForCall() {
  const networker = Object.create(MTPNetworker.prototype) as MTPNetworker;
  Object.assign(networker, {
    log: logger('NET-TEST', LogTypes.Log | LogTypes.Error),
    usingPfs: false,
    connectionInited: true,
    timeManager: {generateId: () => '1234567890'},
    generateSeqNo: () => 1,
    pushMessage: vi.fn(() => Promise.resolve({}))
  });
  return networker;
}

afterEach(() => {
  vi.restoreAllMocks();
  clearLogBuffer();
});

describe.skipIf(!__MTPROTO_PRIVATE__)('private username auth logging and retries', () => {
  it('redacts the real networker logger before console and debug-buffer capture', async() => {
    const networker = createNetworkerForCall();
    const {manager} = createPrivateManager(networker);
    const originalBufferState = isLogBufferEnabled();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const params = {
      phone_number: 'Alice_123',
      phone_code_hash: 'private-code-hash',
      phone_code: ''
    };

    setLogBufferEnabled(true);
    try {
      await manager.getNetworker(2);
      await networker.wrapApiCall('auth.signIn', params);
      await networker.wrapApiCall('help.getConfig', {debug_marker: 'stock-log-value'});

      const loggedOutput = JSON.stringify({
        console: consoleLog.mock.calls,
        buffer: getLogEntries()
      });
      expect(loggedOutput).not.toContain('Alice_123');
      expect(loggedOutput).not.toContain('private-code-hash');
      expect(loggedOutput).toContain('[REDACTED]');
      expect(loggedOutput).toContain('stock-log-value');
    } finally {
      setLogBufferEnabled(originalBufferState);
    }
  });

  it('redacts the manager log for an expected SESSION_PASSWORD_NEEDED rejection', async() => {
    const logError = vi.fn();
    const wrapApiCall = vi.fn().mockRejectedValue({code: 401, type: 'SESSION_PASSWORD_NEEDED'});
    const networker = {
      log: logger('NET-RETRY-TEST', LogTypes.Error),
      wrapApiCall,
      attachPromise: vi.fn()
    } as unknown as MTPNetworker;
    const {manager} = createPrivateManager(networker);
    Object.assign(manager, {log: {error: logError}});
    const params = {
      phone_number: 'Alice_123',
      phone_code_hash: 'private-code-hash',
      phone_code: ''
    };

    await expect(manager.invokeApi('auth.signIn', params, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({type: 'SESSION_PASSWORD_NEEDED'});

    expect(logError).toHaveBeenCalledOnce();
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toContain('Alice_123');
    expect(logged).not.toContain('private-code-hash');
    expect(logged).toContain('[REDACTED]');
  });

  it.each(AUTH_METHODS)('does not retry %s after a server 500', async(method) => {
    const error = {code: 500, type: 'UNKNOWN'};
    const wrapApiCall = vi.fn().mockRejectedValue(error);
    const networker = {
      log: logger('NET-RETRY-TEST', LogTypes.Error),
      wrapApiCall,
      attachPromise: vi.fn()
    } as unknown as MTPNetworker;
    const {manager} = createPrivateManager(networker);

    await expect(manager.invokeApi(method as any, {}, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({code: 500});

    expect(wrapApiCall).toHaveBeenCalledOnce();
    expect(wrapApiCall).toHaveBeenCalledWith(method, {}, expect.objectContaining({rawError: true}));
  });

  it.each(AUTH_METHODS)('surfaces %s UNKNOWN errors after one request', async(method) => {
    const error = {code: 0, type: 'UNKNOWN'};
    const wrapApiCall = vi.fn().mockRejectedValue(error);
    const networker = {
      log: logger('NET-RETRY-TEST', LogTypes.Error),
      wrapApiCall,
      attachPromise: vi.fn()
    } as unknown as MTPNetworker;
    const {manager} = createPrivateManager(networker);

    await expect(manager.invokeApi(method as any, {}, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({code: 0, type: 'NETWORK_BAD_RESPONSE'});

    expect(wrapApiCall).toHaveBeenCalledOnce();
  });
});
