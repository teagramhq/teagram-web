import type {MethodDeclMap} from '@layer';
import type {InvokeApiOptions} from '@types';
import type {CancellablePromise} from '@helpers/cancellablePromise';
import type {Logger} from '@lib/logger';

import {ApiManager as BaseApiManager} from './apiManager';

type AuthLogRedaction = {
  originalError: Logger['error'],
  redactingError: Logger['error'],
  activeRequests: number
};

export class ApiManager extends BaseApiManager {
  private authLogRedaction?: AuthLogRedaction;

  public override invokeApi<T extends keyof MethodDeclMap>(
    method: T,
    params: MethodDeclMap[T]['req'] = {},
    options: InvokeApiOptions = {}
  ): CancellablePromise<MethodDeclMap[T]['res']> {
    if(!String(method).startsWith('auth.')) {
      return super.invokeApi(method, params, options);
    }

    this.beginAuthLogRedaction();
    try {
      const request = super.invokeApi(method, params, options);
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
