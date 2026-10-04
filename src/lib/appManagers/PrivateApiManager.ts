import type {MethodDeclMap} from '@layer';
import type {DcId, InvokeApiOptions} from '@types';
import type {CancellablePromise} from '@helpers/cancellablePromise';
import type {Logger} from '@lib/logger';
import type MTPNetworker from '@lib/mtproto/networker';

import {ApiManager as BaseApiManager} from './apiManager';

const PRIVATE_USERNAME_AUTH_METHODS = new Set(['auth.sendCode', 'auth.signIn', 'auth.checkPassword']);
const privateNetworkers = new WeakSet<object>();

type NetworkerWithLogger = {
  log: Logger,
  sentMessages: Record<string, {humanReadable?: string, container?: boolean, inner?: string[]}>,
  wrapApiCall: MTPNetworker['wrapApiCall']
};

function redactAuthCallArgs(args: any[]) {
  if(args[0] !== 'call' || typeof args[1] !== 'string' || !args[1].startsWith('auth.')) {
    return args;
  }

  return [args[0], args[1], '[REDACTED]', '[REDACTED]', '[REDACTED]'];
}

function isAuthRequest(message: any) {
  return !!message && typeof message === 'object' && typeof message.humanReadable === 'string' && message.humanReadable.startsWith('auth.');
}

function containsAuthRequest(
  message: any,
  sentMessages: NetworkerWithLogger['sentMessages'],
  visited = new WeakSet<object>(),
  visitedIds = new Set<string>()
): boolean {
  if(!message || typeof message !== 'object') return false;
  if(visited.has(message)) return false;
  visited.add(message);
  if(Array.isArray(message)) return message.some((value) => containsAuthRequest(value, sentMessages, visited, visitedIds));

  if(isAuthRequest(message)) return true;

  if(message._ === 'message' && containsAuthRequest(message.body, sentMessages, visited, visitedIds)) {
    return true;
  }

  if(typeof message.req_msg_id === 'string' && !visitedIds.has(message.req_msg_id)) {
    visitedIds.add(message.req_msg_id);
    if(containsAuthRequest(sentMessages[message.req_msg_id], sentMessages, visited, visitedIds)) return true;
  }

  if(message.container && Array.isArray(message.inner) && message.inner.some((messageId: string) => {
    if(visitedIds.has(messageId)) return false;
    visitedIds.add(messageId);
    return containsAuthRequest(sentMessages[messageId], sentMessages, visited, visitedIds);
  })) {
    return true;
  }

  return message._ === 'msg_container' && Array.isArray(message.messages) && message.messages.some((innerMessage: any) => (
    containsAuthRequest(innerMessage, sentMessages, visited, visitedIds)
  ));
}

function redactAuthResponseValue(value: any, visited = new WeakMap<object, any>()): any {
  if(!value || typeof value !== 'object') return value;

  const existing = visited.get(value);
  if(existing) return existing;

  if(Array.isArray(value)) {
    const redacted: any[] = [];
    visited.set(value, redacted);
    value.forEach((item) => redacted.push(redactAuthResponseValue(item, visited)));
    return redacted;
  }

  const prototype = Object.getPrototypeOf(value);
  if(prototype !== Object.prototype && prototype !== null) return value;

  const redacted = Object.create(prototype);
  visited.set(value, redacted);
  Object.keys(value).forEach((key) => {
    redacted[key] = key === 'username' ? '[REDACTED]' : redactAuthResponseValue(value[key], visited);
  });
  return redacted;
}

function redactPrivateLogValue(value: any, sentMessages: NetworkerWithLogger['sentMessages'], authContext: boolean): any {
  if(!value || typeof value !== 'object') return value;
  if(value instanceof Error && authContext) {
    const errorType = (value as Error & {type?: string}).type;
    return typeof errorType === 'string' ? {type: errorType} : {name: value.name};
  }
  if(authContext && typeof value.type === 'string' && ('message' in value || 'code' in value || 'originalError' in value)) {
    return {type: value.type};
  }

  if(isAuthRequest(value) || (value.container && containsAuthRequest(value, sentMessages))) {
    return {...value, body: '[REDACTED]'};
  }

  if(authContext && value._ === 'message' && containsAuthRequest(value.body, sentMessages)) {
    return {...value, body: redactPrivateLogValue(value.body, sentMessages, true)};
  }

  if(authContext && typeof value._ === 'string' && value._.startsWith('auth.')) {
    return redactAuthResponseValue(value);
  }

  if(value._ === 'rpc_error' && authContext) {
    return {...value, error_message: '[REDACTED]'};
  }

  if(value._ === 'rpc_result' && containsAuthRequest(value, sentMessages)) {
    return {...value, result: redactPrivateLogValue(value.result, sentMessages, true)};
  }

  if(value._ === 'msg_container' && Array.isArray(value.messages) && containsAuthRequest(value, sentMessages)) {
    return {...value, messages: value.messages.map((message: any) => redactPrivateLogValue(message, sentMessages, true))};
  }

  if(Array.isArray(value)) {
    return value.map((item) => redactPrivateLogValue(item, sentMessages, authContext));
  }

  return value;
}

function redactPrivateLogArgs(args: any[], sentMessages: NetworkerWithLogger['sentMessages']) {
  const hasAuthRequest = args.some((value) => containsAuthRequest(value, sentMessages));
  const authCallArgs = redactAuthCallArgs(args);
  if(!hasAuthRequest) return authCallArgs;

  return authCallArgs.map((value, index) => index === 0 ? value : redactPrivateLogValue(value, sentMessages, true));
}

function wrapPrivateNetworkerLogger(boundLogger: Logger, sentMessages: NetworkerWithLogger['sentMessages']): Logger {
  return new Proxy(boundLogger, {
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg, redactPrivateLogArgs(args, sentMessages));
    },
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if(typeof member !== 'function') return member;

      if(property === 'bindPrefix') {
        return (...args: any[]) => wrapPrivateNetworkerLogger(Reflect.apply(member, target, args), sentMessages);
      }

      return (...args: any[]) => Reflect.apply(member, target, redactPrivateLogArgs(args, sentMessages));
    }
  });
}

function securePrivateNetworker(networker: MTPNetworker): MTPNetworker {
  if(privateNetworkers.has(networker)) return networker;
  privateNetworkers.add(networker);

  const privateNetworker = networker as unknown as NetworkerWithLogger;
  const networkerLogger = privateNetworker.log;
  privateNetworker.log = wrapPrivateNetworkerLogger(networkerLogger, privateNetworker.sentMessages);

  const wrapApiCall = privateNetworker.wrapApiCall;
  privateNetworker.wrapApiCall = function(method, params, options) {
    const request = Reflect.apply(wrapApiCall, networker, [method, params, options]);
    if(!PRIVATE_USERNAME_AUTH_METHODS.has(method)) return request;

    return request.catch((error: ApiError) => {
      if(error?.type === 'UNKNOWN' || error?.type === 'MTPROTO_CLUSTER_INVALID') {
        throw {...error, type: 'NETWORK_BAD_RESPONSE'};
      }

      throw error;
    });
  };

  return networker;
}

type AuthLogRedaction = {
  originalError: Logger['error'],
  redactingError: Logger['error'],
  activeRequests: number
};

export class ApiManager extends BaseApiManager {
  private authLogRedaction?: AuthLogRedaction;

  public override getNetworker(dcId: DcId, options: InvokeApiOptions = {}): Promise<MTPNetworker> {
    return super.getNetworker(dcId, options).then(securePrivateNetworker);
  }

  public override invokeApi<T extends keyof MethodDeclMap>(
    method: T,
    params: MethodDeclMap[T]['req'] = {},
    options: InvokeApiOptions = {}
  ): CancellablePromise<MethodDeclMap[T]['res']> {
    const methodName = String(method);
    if(!methodName.startsWith('auth.')) {
      return super.invokeApi(method, params, options);
    }

    this.beginAuthLogRedaction();
    try {
      const requestOptions = PRIVATE_USERNAME_AUTH_METHODS.has(methodName) ? {...options, rawError: true} : options;
      const request = super.invokeApi(method, params, requestOptions);
      request.then(() => this.endAuthLogRedaction(), () => this.endAuthLogRedaction());
      return request;
    } catch(error) {
      this.endAuthLogRedaction();
      throw error;
    }
  }

  private beginAuthLogRedaction() {
    if(this.authLogRedaction) {
      this.authLogRedaction.activeRequests++;
      return;
    }

    const originalError = this.log.error;
    const redactingError: Logger['error'] = (...args: any[]) => {
      const methodIndex = args[0] === 'Error' ? 5 : args[0] === 'Request is still processing:' ? 1 : -1;
      if(methodIndex !== -1 && typeof args[methodIndex] === 'string' && args[methodIndex].startsWith('auth.')) {
        const redactedArgs = args.slice();
        redactedArgs[methodIndex + 1] = '[REDACTED]';
        return originalError(...redactedArgs);
      }

      return originalError(...args);
    };

    this.authLogRedaction = {originalError, redactingError, activeRequests: 1};
    this.log.error = redactingError;
  }

  private endAuthLogRedaction() {
    const redaction = this.authLogRedaction;
    if(!redaction) return;

    redaction.activeRequests--;
    if(redaction.activeRequests !== 0) return;

    if(this.log.error === redaction.redactingError) this.log.error = redaction.originalError;
    this.authLogRedaction = undefined;
  };
}
