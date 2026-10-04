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
    sentMessages: {},
    pushMessage: vi.fn(() => Promise.resolve({}))
  });
  return networker;
}

async function capturePrivateRpcResponse(result: any) {
  const networker = createNetworkerForCall();
  (networker as any).log = logger('NET-RPC-RESPONSE-TEST', LogTypes.Log | LogTypes.Error | LogTypes.Debug, true);
  const {manager} = createPrivateManager(networker);
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const originalBufferState = isLogBufferEnabled();
  const requestBody = 'private-auth-rpc-body';
  const deferred = {resolve: vi.fn(), reject: vi.fn()};
  const sentMessage: any = {
    msg_id: 'auth-response-request-id',
    seq_no: 1,
    body: requestBody,
    humanReadable: 'auth.signIn',
    isAPI: true,
    resultType: 'Object',
    deferred
  };

  Object.assign(networker, {
    sentMessages: {'auth-response-request-id': sentMessage},
    ackMessage: vi.fn(),
    processResentReqMessage: vi.fn()
  });

  setLogBufferEnabled(true);
  try {
    await manager.getNetworker(2);
    networker.processMessage({_: 'rpc_result', req_msg_id: sentMessage.msg_id, result}, '00000000000000000002', new Uint8Array(8));
    const responseLog = consoleLog.mock.calls.find((args) => args.includes(result._ === 'rpc_error' ? 'rpc error' : 'rpc result'));

    return {
      consoleOutput: JSON.stringify({log: consoleLog.mock.calls, debug: consoleDebug.mock.calls}),
      bufferedOutput: JSON.stringify(getLogEntries()),
      responseLog,
      requestBody,
      sentMessage,
      deferred
    };
  } finally {
    setLogBufferEnabled(originalBufferState);
  }
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

  it('redacts private auth message bodies in the encrypted-request debug log', async() => {
    const networker = createNetworkerForCall();
    (networker as any).log = logger('NET-DEBUG-TEST', LogTypes.Error | LogTypes.Debug, true);
    const {manager} = createPrivateManager(networker);
    const requestNetworker = networker as any;
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const originalBufferState = isLogBufferEnabled();
    const message = {
      msg_id: '1234567890',
      seq_no: 1,
      humanReadable: 'auth.signIn',
      body: 'private-auth-body'
    };

    vi.spyOn(requestNetworker, 'getEncryptedOutput').mockResolvedValue(new Uint8Array([1, 2, 3]));
    Object.assign(networker, {transport: {send: vi.fn().mockResolvedValue(new Uint8Array([1]))}});

    setLogBufferEnabled(true);
    try {
      await manager.getNetworker(2);
      await requestNetworker.sendEncryptedRequest(message);

      const debugCall = consoleDebug.mock.calls.find((args) => args.includes('sending'));
      expect(debugCall?.[4]).toMatchObject({humanReadable: 'auth.signIn', body: '[REDACTED]'});

      const bufferedCall = getLogEntries().find((entry) => entry.prefix.includes('sendEncryptedRequest'));
      expect(bufferedCall?.args[1]).toMatchObject({humanReadable: 'auth.signIn', body: '[REDACTED]'});
    } finally {
      setLogBufferEnabled(originalBufferState);
    }
  });

  it('redacts encrypted containers that include private auth messages', async() => {
    const networker = createNetworkerForCall();
    (networker as any).log = logger('NET-CONTAINER-DEBUG-TEST', LogTypes.Error | LogTypes.Debug, true);
    const {manager} = createPrivateManager(networker);
    const requestNetworker = networker as any;
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const originalBufferState = isLogBufferEnabled();
    const message = {
      msg_id: 'container-message-id',
      seq_no: 1,
      container: true,
      inner: ['auth-message-id'],
      body: 'private-auth-container-body'
    };

    requestNetworker.sentMessages = {
      'auth-message-id': {humanReadable: 'auth.signIn', body: 'private-auth-message-body'}
    };
    const getEncryptedOutput = vi.spyOn(requestNetworker, 'getEncryptedOutput').mockResolvedValue(new Uint8Array([1, 2, 3]));
    Object.assign(networker, {transport: {send: vi.fn().mockResolvedValue(new Uint8Array([1]))}});

    setLogBufferEnabled(true);
    try {
      await manager.getNetworker(2);
      await requestNetworker.sendEncryptedRequest(message);

      const debugCall = consoleDebug.mock.calls.find((args) => args.includes('sending'));
      expect(debugCall?.[4]).toMatchObject({container: true, body: '[REDACTED]'});

      const bufferedCall = getLogEntries().find((entry) => entry.prefix.includes('sendEncryptedRequest'));
      expect(bufferedCall?.args[1]).toMatchObject({container: true, body: '[REDACTED]'});
      expect(getEncryptedOutput).toHaveBeenCalledWith(message);
      expect(message.body).toBe('private-auth-container-body');
    } finally {
      setLogBufferEnabled(originalBufferState);
    }
  });

  it('redacts acknowledged auth request bodies and usernames from real successful rpc_result logs', async() => {
    const result = {_: 'auth.authorization', user: {id: 123, username: 'Alice_123'}};
    const capture = await capturePrivateRpcResponse(result);

    expect(capture.consoleOutput).not.toContain(capture.requestBody);
    expect(capture.bufferedOutput).not.toContain(capture.requestBody);
    expect(capture.consoleOutput).not.toContain('Alice_123');
    expect(capture.bufferedOutput).not.toContain('Alice_123');
    expect(JSON.stringify(capture.responseLog)).toContain('"username":"[REDACTED]"');
    expect(capture.bufferedOutput).toContain('"username":"[REDACTED]"');
    expect(capture.consoleOutput).toContain('[REDACTED]');
    expect(capture.bufferedOutput).toContain('[REDACTED]');
    expect(result.user.username).toBe('Alice_123');
    expect(capture.deferred.resolve).toHaveBeenCalledWith(result);
    expect(capture.sentMessage.acked).toBe(true);
    expect(capture.sentMessage.body).toBe(capture.requestBody);
  });

  it('redacts auth request bodies and raw errors from real failing rpc_result logs', async() => {
    const result = {_: 'rpc_error', error_code: 401, error_message: 'SESSION_PASSWORD_NEEDED:private-auth-error-detail'};
    const capture = await capturePrivateRpcResponse(result);

    expect(capture.consoleOutput).not.toContain(capture.requestBody);
    expect(capture.bufferedOutput).not.toContain(capture.requestBody);
    expect(capture.consoleOutput).not.toContain('private-auth-error-detail');
    expect(capture.bufferedOutput).not.toContain('private-auth-error-detail');
    expect(capture.responseLog?.some((value) => value instanceof Error)).toBe(false);
    expect(capture.deferred.reject).toHaveBeenCalledWith(expect.objectContaining({type: 'SESSION_PASSWORD_NEEDED'}));
    expect(capture.sentMessage.acked).toBe(true);
    expect(capture.sentMessage.body).toBe(capture.requestBody);
  });

  it('redacts auth messages nested in arguments to the root networker logger', async() => {
    const networker = createNetworkerForCall();
    (networker as any).log = logger('NET-ROOT-LOGGER-TEST', LogTypes.Error | LogTypes.Debug, true);
    const {manager} = createPrivateManager(networker);
    const requestNetworker = networker as any;
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const originalBufferState = isLogBufferEnabled();
    const message = {msg_id: 'nested-auth-message-id', humanReadable: 'auth.sendCode', body: 'nested-private-auth-body'};
    requestNetworker.sentMessages = {};

    setLogBufferEnabled(true);
    try {
      await manager.getNetworker(2);
      requestNetworker.log.debug('nested request message', [message]);

      expect(JSON.stringify(consoleDebug.mock.calls)).not.toContain(message.body);
      expect(JSON.stringify(getLogEntries())).not.toContain(message.body);
      expect(JSON.stringify(consoleDebug.mock.calls)).toContain('[REDACTED]');
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
