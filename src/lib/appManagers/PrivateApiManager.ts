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
  wrapApiCall: MTPNetworker['wrapApiCall']
};

function redactAuthCallArgs(args: any[]) {
  if(args[0] !== 'call' || typeof args[1] !== 'string' || !args[1].startsWith('auth.')) {
    return args;
  }

  return [args[0], args[1], '[REDACTED]', '[REDACTED]', '[REDACTED]'];
}

function wrapAuthCallLogger(boundLogger: Logger): Logger {
  return new Proxy(boundLogger, {
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg, redactAuthCallArgs(args));
    },
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if(typeof member !== 'function') return member;

      return (...args: any[]) => Reflect.apply(member, target, redactAuthCallArgs(args));
    }
  });
}

function securePrivateNetworker(networker: MTPNetworker): MTPNetworker {
  if(privateNetworkers.has(networker)) return networker;
  privateNetworkers.add(networker);

  const privateNetworker = networker as unknown as NetworkerWithLogger;
  const networkerLogger = privateNetworker.log;
  const bindPrefix = networkerLogger.bindPrefix;
  privateNetworker.log = new Proxy(networkerLogger, {
    get(target, property, receiver) {
      if(property !== 'bindPrefix') {
        return Reflect.get(target, property, receiver);
      }

      return (prefix: string, ...args: any[]) => {
        const boundLogger = Reflect.apply(bindPrefix, target, [prefix, ...args]);
        return prefix === 'wrapApiCall' ? wrapAuthCallLogger(boundLogger) : boundLogger;
      };
    }
  });

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
