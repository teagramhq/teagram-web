import {afterEach, describe, expect, it, vi} from 'vitest';

import {ApiManager} from '@appManagers/apiManager';
import {PerformanceRpcTrace} from '@appManagers/performanceTrace';
import {ApiManager as BaseApiManager} from '../../lib/appManagers/apiManager';
import {secureAuthNetworker} from '../../lib/appManagers/authLogRedaction';
import {clearLogBuffer, getLogEntries, isLogBufferEnabled, setLogBufferEnabled} from '@lib/debug/logsBuffer';
import {LogTypes, logger} from '@lib/logger';
import MTPNetworker from '@lib/mtproto/networker';
import deferredPromise from '@helpers/cancellablePromise';

const AUTH_METHODS = ['auth.sendCode', 'auth.signIn', 'auth.checkPassword'] as const;

function createPrivateManager(networker: Pick<MTPNetworker, 'wrapApiCall' | 'attachPromise'>) {
  const logError = vi.fn();
  const manager = Object.create(ApiManager.prototype) as ApiManager;
  Object.assign(manager, {
    baseDcId: 2,
    performanceRpcTrace: new PerformanceRpcTrace(false),
    log: {error: logError}
  });
  vi.spyOn(BaseApiManager.prototype, 'getNetworker').mockImplementation(() => Promise.resolve(secureAuthNetworker(networker as MTPNetworker)));
  return {manager, logError};
}

function createStandardManager(networker: MTPNetworker) {
  const logError = vi.fn();
  const manager = Object.create(BaseApiManager.prototype) as BaseApiManager;
  const cachedNetworkers = Object.fromEntries(['http', 'https', 'websocket'].map((transportType) => [transportType, {
    client: {2: [networker]},
    download: {},
    upload: {}
  }]));
  Object.assign(manager, {
    baseDcId: 2,
    cachedNetworkers,
    performanceRpcTrace: new PerformanceRpcTrace(false),
    transportType: 'https',
    rootScope: {myId: 0},
    log: {error: logError}
  });
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

async function capturePrivateRpcResponse(result: any, method = 'auth.signIn', wrappedParams?: any) {
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
    humanReadable: method,
    isAPI: true,
    resultType: 'Object',
    deferred
  };

  Object.assign(networker, {
    sentMessages: {'auth-response-request-id': sentMessage},
    lastServerMessages: new Set(),
    ackMessage: vi.fn(),
    processResentReqMessage: vi.fn()
  });

  const inboundContainer = {
    _: 'msg_container',
    messages: [{
      _: 'message',
      msg_id: '00000000000000000004',
      seqno: 1,
      bytes: 64,
      body: {_: 'rpc_result', req_msg_id: sentMessage.msg_id, result}
    }]
  };

  setLogBufferEnabled(true);
  try {
    await manager.getNetworker(2);
    if(wrappedParams) (networker as any).log('call', method, sentMessage, wrappedParams, {});
    networker.processMessage(inboundContainer, '00000000000000000002', new Uint8Array(8));
    const responseLog = consoleLog.mock.calls.find((args) => args.includes(result._ === 'rpc_error' ? 'rpc error' : 'rpc result'));

    return {
      consoleOutput: JSON.stringify({log: consoleLog.mock.calls, debug: consoleDebug.mock.calls}),
      bufferedOutput: JSON.stringify(getLogEntries()),
      responseLog,
      requestBody,
      inboundContainer,
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

describe('standard auth logging', () => {
  it('redacts wrapped signin tokens and SRP parameters from manager and networker logs', async() => {
    const networker = createNetworkerForCall();
    const wrapApiCall = vi.fn().mockRejectedValue({code: 400, type: 'RECAPTCHA_CHECK_signin__standard-site-key'});
    Object.assign(networker, {wrapApiCall, attachPromise: vi.fn()});
    const {manager, logError} = createStandardManager(networker);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalBufferState = isLogBufferEnabled();
    const params = {
      token: 'standard-turnstile-token',
      query: {
        _: 'auth.checkPassword',
        password: {_ : 'inputCheckPasswordSRP', srp_id: 'standard-srp-id', A: 'standard-srp-A', M1: 'standard-srp-M1'}
      }
    };
    const message = {msg_id: 'standard-auth-message-id', humanReadable: 'invokeWithReCaptcha', body: 'standard-auth-body'};

    setLogBufferEnabled(true);
    try {
      await manager.getNetworker(2);
      (networker as any).log('call', 'invokeWithReCaptcha', message, params, {});
      await expect(manager.invokeApi('invokeWithReCaptcha', params, {dcId: 2, ignoreErrors: true}))
      .rejects.toMatchObject({type: 'RECAPTCHA_CHECK_signin__standard-site-key'});

      const logged = JSON.stringify({console: consoleLog.mock.calls, buffer: getLogEntries(), errors: logError.mock.calls});
      for(const sentinel of [
        'standard-turnstile-token',
        'standard-srp-id',
        'standard-srp-A',
        'standard-srp-M1',
        'standard-auth-body'
      ]) {
        expect(logged).not.toContain(sentinel);
      }
      expect(logged).toContain('[REDACTED]');
    } finally {
      setLogBufferEnabled(originalBufferState);
    }
  });
});

describe('networker transport errors', () => {
  it('rejects every pending request with AUTH_KEY_UNKNOWN without logging key material or resending', async() => {
    const networker = createNetworkerForCall() as any;
    const first = deferredPromise<void>();
    const second = deferredPromise<void>();
    const keyMaterial = 'ab'.repeat(256);
    const serverSalt = 'cd'.repeat(8);
    const log = vi.fn();
    Object.assign(log, {bindPrefix: () => ({debug: vi.fn()})});
    Object.assign(networker, {
      log,
      isCurrentForDc: () => true,
      permAuthKey: {key: keyMaterial},
      serverSalt,
      sentMessages: {
        first: {deferred: first, body: keyMaterial},
        second: {deferred: second, body: 'private-request-body'}
      },
      pendingMessages: {first: 0, second: 0},
      pendingAcks: [],
      pendingResendReq: ['first'],
      sentResendReq: new Map([['response', {}]]),
      nextReq: 0,
      scheduleRequest: vi.fn()
    });

    networker.onTransportError(-404);

    await expect(first).rejects.toMatchObject({type: 'AUTH_KEY_UNKNOWN', code: -404});
    await expect(second).rejects.toMatchObject({type: 'AUTH_KEY_UNKNOWN', code: -404});
    expect(networker.sentMessages).toEqual({});
    expect(networker.pendingMessages).toEqual({});
    expect(networker.pendingResendReq).toEqual([]);
    expect(networker.sentResendReq.size).toBe(0);
    expect(networker.scheduleRequest).not.toHaveBeenCalled();
    expect(networker.permAuthKey.key).toBe(keyMaterial);
    expect(networker.serverSalt).toBe(serverSalt);
    expect(JSON.stringify(log.mock.calls)).not.toContain(keyMaterial);
    expect(JSON.stringify(log.mock.calls)).not.toContain(serverSalt);
  });

  it('preserves pending requests when a stale networker receives a transport error', () => {
    const networker = createNetworkerForCall() as any;
    const pending = deferredPromise<void>();
    const sentMessage = {deferred: pending};
    const {manager} = createStandardManager(networker);
    const cachedNetworkers = (manager as any).cachedNetworkers;
    Object.assign(networker, {
      isCurrentForDc: () => (manager as any).isNetworkerCurrentForDc(2, networker),
      sentMessages: {pending: sentMessage},
      pendingMessages: {pending: 0}
    });
    expect(networker.isCurrentForDc()).toBe(true);
    for(const transportType of Object.keys(cachedNetworkers)) {
      cachedNetworkers[transportType].client[2] = [];
    }

    networker.onTransportError(-404);

    expect(pending.isRejected).toBe(false);
    expect(networker.sentMessages.pending).toBe(sentMessage);
    expect(networker.pendingMessages.pending).toBe(0);
  });

  it.each([
    [-429, 'AUTH_KEY_RATE_LIMIT'],
    [-400, 'MTPROTO_TRANSPORT_ERROR']
  ])('classifies transport code %s without re-keying', async(code, type) => {
    const networker = createNetworkerForCall() as any;
    const pending = deferredPromise<void>();
    const authKey = {key: 'stored-auth-key'};
    const serverSalt = 'stored-server-salt';
    const log = vi.fn();
    Object.assign(log, {bindPrefix: () => ({debug: vi.fn()})});
    Object.assign(networker, {
      log,
      isCurrentForDc: () => true,
      permAuthKey: authKey,
      serverSalt,
      sentMessages: {pending: {deferred: pending}},
      pendingMessages: {pending: 0},
      pendingAcks: [],
      pendingResendReq: [],
      sentResendReq: new Map(),
      nextReq: 0,
      scheduleRequest: vi.fn()
    });

    networker.onTransportError(code);

    await expect(pending).rejects.toMatchObject({type, code});
    expect(networker.permAuthKey).toBe(authKey);
    expect(networker.serverSalt).toBe(serverSalt);
    expect(networker.scheduleRequest).not.toHaveBeenCalled();
  });
});

describe('auth-key recovery request metadata', () => {
  it('returns a recovery handle only to the flagged auth call and hides its flag from the networker', async() => {
    const networker = createNetworkerForCall();
    const wrapApiCall = vi.fn().mockRejectedValue({code: -404, type: 'AUTH_KEY_UNKNOWN'});
    Object.assign(networker, {
      dcId: 2,
      permAuthKey: {key: new Uint8Array(256).fill(0xaa)},
      wrapApiCall,
      attachPromise: vi.fn()
    });
    const {manager} = createStandardManager(networker);

    await expect(manager.invokeApi('auth.sendCode', {phone_number: 'Alice_123'} as any, {
      dcId: 2,
      ignoreErrors: true,
      authKeyRecovery: true
    })).rejects.toMatchObject({type: 'AUTH_KEY_UNKNOWN', authKeyRecoveryId: 1});

    expect(wrapApiCall).toHaveBeenCalledWith(
      'auth.sendCode',
      {phone_number: 'Alice_123'},
      expect.not.objectContaining({authKeyRecovery: true})
    );

    let unrelatedError: unknown;
    await manager.invokeApi('auth.sendCode', {phone_number: 'Alice_123'} as any, {
      dcId: 2,
      ignoreErrors: true
    }).catch((error) => { unrelatedError = error; });
    expect(unrelatedError).toMatchObject({type: 'AUTH_KEY_UNKNOWN'});
    expect(unrelatedError).not.toHaveProperty('authKeyRecoveryId');
  });

  it('keeps auth-key recovery enabled when a sign-in migrates to another DC', async() => {
    const sourceNetworker = createNetworkerForCall();
    const destinationNetworker = createNetworkerForCall();
    const params = {phone_number: 'Alice_123'};
    const sourceCall = vi.fn().mockRejectedValue({code: 303, type: 'PHONE_MIGRATE_4'});
    const destinationCall = vi.fn().mockRejectedValue({code: -404, type: 'AUTH_KEY_UNKNOWN'});
    Object.assign(sourceNetworker, {
      dcId: 2,
      wrapApiCall: sourceCall,
      attachPromise: vi.fn()
    });
    Object.assign(destinationNetworker, {
      dcId: 4,
      wrapApiCall: destinationCall,
      attachPromise: vi.fn()
    });
    const {manager} = createStandardManager(sourceNetworker);
    const cachedNetworkers = (manager as any).cachedNetworkers;
    for(const transportType of Object.keys(cachedNetworkers)) {
      cachedNetworkers[transportType].client[4] = [destinationNetworker];
    }

    await expect(manager.invokeApi('auth.signIn', params as any, {
      dcId: 2,
      ignoreErrors: true,
      authKeyRecovery: true
    })).rejects.toMatchObject({type: 'AUTH_KEY_UNKNOWN', authKeyRecoveryId: 1});

    expect(sourceCall).toHaveBeenCalledOnce();
    expect(destinationCall).toHaveBeenCalledWith(
      'auth.signIn',
      params,
      expect.not.objectContaining({authKeyRecovery: true})
    );
  });

  it('does not return a recovery handle for a failure from a superseded transport', async() => {
    const networker = createNetworkerForCall();
    const oldTransport = {} as any;
    const newTransport = {} as any;
    const wrapApiCall = vi.fn().mockImplementation(async() => {
      networker.transport = newTransport;
      throw {code: -404, type: 'AUTH_KEY_UNKNOWN'};
    });
    Object.assign(networker, {
      dcId: 2,
      permAuthKey: {key: new Uint8Array(256).fill(0xaa)},
      transport: oldTransport,
      wrapApiCall,
      attachPromise: vi.fn()
    });
    const {manager} = createStandardManager(networker);
    let responseError: unknown;

    await manager.invokeApi('auth.sendCode', {phone_number: 'Alice_123'} as any, {
      dcId: 2,
      ignoreErrors: true,
      authKeyRecovery: true
    }).catch((error) => { responseError = error; });

    expect(responseError).toMatchObject({type: 'AUTH_KEY_UNKNOWN'});
    expect(responseError).not.toHaveProperty('authKeyRecoveryId');
  });
});

describe('standard wrapped auth transport failures', () => {
  it.each([
    ['auth.sendCode', 'UNKNOWN'],
    ['auth.sendCode', 'MTPROTO_CLUSTER_INVALID'],
    ['auth.checkPassword', 'UNKNOWN'],
    ['auth.checkPassword', 'MTPROTO_CLUSTER_INVALID']
  ])('does not replay wrapped %s after %s', async(method, type) => {
    const error = {code: 0, type};
    const wrapApiCall = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({_: 'auth.result'});
    const networker = createNetworkerForCall();
    Object.assign(networker, {wrapApiCall, attachPromise: vi.fn()});
    const {manager} = createStandardManager(networker);
    const params = {
      token: 'consumed-turnstile-token',
      query: {
        _: method,
        ...(method === 'auth.sendCode' ? {phone_number: 'Alice_123'} : {password: {_ : 'inputCheckPasswordSRP', srp_id: 'stale-proof'}})
      }
    };

    await expect(manager.invokeApi('invokeWithReCaptcha', params as any, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({code: 0, type});

    expect(wrapApiCall).toHaveBeenCalledOnce();
    expect(wrapApiCall).toHaveBeenCalledWith('invokeWithReCaptcha', params, expect.objectContaining({rawError: true}));
  });
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

  it('redacts pending auth requests from transport-missing networker error logs', async() => {
    const networker = createNetworkerForCall();
    (networker as any).log = logger('NET-OFFLINE-TEST', LogTypes.Error);
    const {manager} = createPrivateManager(networker);
    const requestNetworker = networker as any;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalBufferState = isLogBufferEnabled();
    const requestBody = 'private-offline-auth-body';
    const message = {
      msg_id: 'offline-auth-message-id',
      seq_no: 1,
      humanReadable: 'auth.signIn',
      body: requestBody
    };

    requestNetworker.sentMessages = {[message.msg_id]: message};
    vi.spyOn(requestNetworker, 'getEncryptedOutput').mockResolvedValue(new Uint8Array([1, 2, 3]));

    setLogBufferEnabled(true);
    try {
      await manager.getNetworker(2);
      await expect(requestNetworker.sendEncryptedRequest(message)).rejects.toBeDefined();

      const errorEntries = getLogEntries().filter((entry) => entry.args[0] === 'trying to send something when offline');
      const loggedOutput = JSON.stringify({console: consoleError.mock.calls, buffer: errorEntries});
      expect(loggedOutput).not.toContain(requestBody);
      expect(loggedOutput).not.toContain(message.msg_id);
      expect(loggedOutput).toContain('MTPNetworker');
      expect(requestNetworker.sentMessages[message.msg_id]).toBe(message);
      expect(message.body).toBe(requestBody);
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

  it('redacts wrapped auth containers while keeping sibling diagnostics useful', async() => {
    const networker = createNetworkerForCall();
    (networker as any).log = logger('NET-WRAPPED-CONTAINER-TEST', LogTypes.Error | LogTypes.Debug, true);
    const {manager} = createPrivateManager(networker);
    const requestNetworker = networker as any;
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const originalBufferState = isLogBufferEnabled();
    const wrappedMessage = {
      msg_id: 'wrapped-auth-message-id',
      humanReadable: 'invokeWithReCaptcha',
      body: 'encoded-wrapped-auth-body'
    };
    const siblingMessage = {
      msg_id: 'useful-sibling-message-id',
      humanReadable: 'help.getConfig',
      body: 'encoded-sibling-body'
    };
    const params = {
      token: 'container-turnstile-token',
      query: {
        _: 'auth.checkPassword',
        password: {_ : 'inputCheckPasswordSRP', A: 'container-srp-A', M1: 'container-srp-M1'}
      }
    };
    const container = {
      container: true,
      inner: [wrappedMessage.msg_id, siblingMessage.msg_id],
      body: 'encoded-container-auth-and-sibling-body'
    };

    requestNetworker.sentMessages = {
      [wrappedMessage.msg_id]: wrappedMessage,
      [siblingMessage.msg_id]: siblingMessage
    };

    setLogBufferEnabled(true);
    try {
      await manager.getNetworker(2);
      requestNetworker.log('call', 'invokeWithReCaptcha', wrappedMessage, params, {});
      requestNetworker.log.debug('sending container', container);
      requestNetworker.log('call', 'help.getConfig', siblingMessage, {diagnostic: 'useful-sibling-diagnostic'}, {});

      const logged = JSON.stringify({consoleLog: consoleLog.mock.calls, consoleDebug: consoleDebug.mock.calls, buffer: getLogEntries()});
      expect(logged).not.toContain('encoded-wrapped-auth-body');
      expect(logged).not.toContain('container-turnstile-token');
      expect(logged).not.toContain('container-srp-A');
      expect(logged).not.toContain('container-srp-M1');
      expect(logged).not.toContain('encoded-container-auth-and-sibling-body');
      expect(logged).toContain('useful-sibling-diagnostic');
      expect(JSON.stringify(consoleDebug.mock.calls)).toContain('[REDACTED]');
      expect(wrappedMessage.body).toBe('encoded-wrapped-auth-body');
      expect(container.body).toBe('encoded-container-auth-and-sibling-body');
    } finally {
      setLogBufferEnabled(originalBufferState);
    }
  });

  it('redacts usernames from real successful inbound msg_container logs', async() => {
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
    expect(capture.inboundContainer.messages[0].body.result.user.username).toBe('Alice_123');
    expect(result.user.username).toBe('Alice_123');
    expect(capture.deferred.resolve).toHaveBeenCalledWith(result);
    expect(capture.sentMessage.acked).toBe(true);
    expect(capture.sentMessage.body).toBe(capture.requestBody);
  });

  it('redacts successful wrapped auth responses and request bodies', async() => {
    const result = {
      _: 'auth.sentCode',
      phone_code_hash: 'wrapped-success-code-hash',
      type: {_ : 'auth.sentCodeTypeApp', length: 5}
    };
    const params = {
      token: 'wrapped-success-turnstile-token',
      query: {
        _: 'auth.sendCode',
        phone_number: 'wrapped-success-username',
        api_hash: 'wrapped-success-api-hash'
      }
    };
    const capture = await capturePrivateRpcResponse(result, 'invokeWithReCaptcha', params);

    expect(capture.consoleOutput).not.toContain(capture.requestBody);
    expect(capture.bufferedOutput).not.toContain(capture.requestBody);
    expect(capture.consoleOutput).not.toContain('wrapped-success-turnstile-token');
    expect(capture.bufferedOutput).not.toContain('wrapped-success-turnstile-token');
    expect(capture.consoleOutput).not.toContain('wrapped-success-username');
    expect(capture.bufferedOutput).not.toContain('wrapped-success-username');
    expect(capture.consoleOutput).not.toContain('wrapped-success-api-hash');
    expect(capture.bufferedOutput).not.toContain('wrapped-success-api-hash');
    expect(capture.consoleOutput).not.toContain('wrapped-success-code-hash');
    expect(capture.bufferedOutput).not.toContain('wrapped-success-code-hash');
    expect(JSON.stringify(capture.responseLog)).toContain('"phone_code_hash":"[REDACTED]"');
    expect(capture.sentMessage.body).toBe(capture.requestBody);
  });

  it('redacts auth request bodies and errors from real failing inbound msg_container logs', async() => {
    const result = {_: 'rpc_error', error_code: 401, error_message: 'SESSION_PASSWORD_NEEDED:private-auth-error-detail'};
    const capture = await capturePrivateRpcResponse(result);

    expect(capture.consoleOutput).not.toContain(capture.requestBody);
    expect(capture.bufferedOutput).not.toContain(capture.requestBody);
    expect(capture.consoleOutput).not.toContain('private-auth-error-detail');
    expect(capture.bufferedOutput).not.toContain('private-auth-error-detail');
    expect(capture.inboundContainer.messages[0].body.result.error_message).toBe('SESSION_PASSWORD_NEEDED:private-auth-error-detail');
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

  it('redacts wrapped auth parameters and preserves raw challenge errors', async() => {
    const error = {code: 400, type: 'RECAPTCHA_CHECK_signin__public-site-key'};
    const wrapApiCall = vi.fn().mockRejectedValue(error);
    const networker = {
      log: logger('NET-WRAPPED-AUTH-TEST', LogTypes.Error),
      wrapApiCall,
      attachPromise: vi.fn()
    } as unknown as MTPNetworker;
    const {manager, logError} = createPrivateManager(networker);
    const params = {
      token: 'private-turnstile-token',
      query: {
        _: 'auth.sendCode',
        phone_number: 'private-username',
        api_hash: 'private-api-hash',
        phone_code_hash: 'private-code-hash'
      }
    };

    await expect(manager.invokeApi('invokeWithReCaptcha', params, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({type: 'RECAPTCHA_CHECK_signin__public-site-key'});

    expect(wrapApiCall).toHaveBeenCalledWith('invokeWithReCaptcha', params, expect.objectContaining({rawError: true}));
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toContain('private-turnstile-token');
    expect(logged).not.toContain('private-username');
    expect(logged).not.toContain('private-api-hash');
    expect(logged).not.toContain('private-code-hash');
    expect(logged).not.toContain('private-srp-A');
    expect(logged).not.toContain('private-srp-M1');
    expect(logged).toContain('[REDACTED]');
  });

  it('keeps wrapped auth timeout redaction active across concurrent requests', async() => {
    const pending: Array<{resolve: (value: unknown) => void, reject: (error: unknown) => void}> = [];
    const wrapApiCall = vi.fn(() => new Promise((resolve, reject) => pending.push({resolve, reject})));
    const networker = {
      log: logger('NET-WRAPPED-CONCURRENT-TEST', LogTypes.Error),
      sentMessages: {},
      wrapApiCall,
      attachPromise: vi.fn()
    } as unknown as MTPNetworker;
    const {manager, logError} = createPrivateManager(networker);
    Object.assign(manager, {log: {error: logError}});
    const firstParams = {token: 'first-concurrent-token', query: {_: 'auth.sendCode', phone_number: 'first-concurrent-user'}};
    const secondParams = {token: 'second-concurrent-token', query: {_: 'auth.checkPassword', password: 'second-concurrent-srp'}};

    const first = manager.invokeApi('invokeWithReCaptcha', firstParams, {dcId: 2, ignoreErrors: true});
    const second = manager.invokeApi('invokeWithReCaptcha', secondParams, {dcId: 2, ignoreErrors: true});
    await vi.waitFor(() => expect(wrapApiCall).toHaveBeenCalledTimes(2));

    pending[0].resolve({_: 'auth.sentCode'});
    await expect(first).resolves.toEqual({_: 'auth.sentCode'});

    manager.log.error('Request is still processing:', 'invokeWithReCaptcha', secondParams, {timeout: 5});
    const timeoutLog = JSON.stringify(logError.mock.calls);
    expect(timeoutLog).not.toContain('second-concurrent-token');
    expect(timeoutLog).not.toContain('second-concurrent-user');
    expect(timeoutLog).not.toContain('second-concurrent-srp');
    expect(timeoutLog).toContain('[REDACTED]');

    pending[1].reject({code: 408, type: 'TIMEOUT'});
    await expect(second).rejects.toMatchObject({type: 'TIMEOUT'});
    expect(JSON.stringify(logError.mock.calls)).not.toContain('second-concurrent-token');
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
