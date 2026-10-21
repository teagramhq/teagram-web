import type {Logger} from '@lib/logger';
import type MTPNetworker from '@lib/mtproto/networker';

const redactedNetworkers = new WeakSet<object>();
const authMessages = new WeakSet<object>();

export const AUTH_METHODS_WITH_RAW_ERRORS = new Set(['auth.sendCode', 'auth.signIn', 'auth.checkPassword']);

export function getAuthMethod(method: unknown, params: any): string | undefined {
  if(typeof method !== 'string') return;
  if(method.startsWith('auth.')) return method;

  if(method === 'invokeWithReCaptcha' && typeof params?.query?._ === 'string' && params.query._.startsWith('auth.')) {
    return params.query._;
  }
}

type NetworkerWithLogger = {
  log: Logger,
  sentMessages: Record<string, {humanReadable?: string, container?: boolean, inner?: string[]}>,
  wrapApiCall: MTPNetworker['wrapApiCall'],
  generateSeqNo: MTPNetworker['generateSeqNo']
};

function redactAuthCallArgs(args: any[]) {
  if(args[0] !== 'call' || !getAuthMethod(args[1], args[3])) {
    return args;
  }

  if(args[2] && typeof args[2] === 'object') authMessages.add(args[2]);
  return [args[0], args[1], '[REDACTED]', '[REDACTED]', '[REDACTED]'];
}

function isAuthRequest(message: any) {
  return !!message && typeof message === 'object' && (
    authMessages.has(message) ||
    !!getAuthMethod(message.humanReadable, message.params) ||
    (message._ === 'invokeWithReCaptcha' && !!getAuthMethod(message._, message))
  );
}

function isNetworkerLogValue(value: any) {
  return !!value && typeof value === 'object' && typeof value.wrapApiCall === 'function' &&
    typeof value.generateSeqNo === 'function' && !!value.sentMessages && typeof value.sentMessages === 'object';
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
  if(!value || typeof value !== 'object') return '[REDACTED]';

  const existing = visited.get(value);
  if(existing) return existing;

  if(Array.isArray(value)) {
    const redacted: any[] = [];
    visited.set(value, redacted);
    value.forEach((item) => redacted.push(redactAuthResponseValue(item, visited)));
    return redacted;
  }

  const prototype = Object.getPrototypeOf(value);
  if(prototype !== Object.prototype && prototype !== null) return '[REDACTED]';

  const redacted = Object.create(prototype);
  visited.set(value, redacted);
  Object.keys(value).forEach((key) => {
    redacted[key] = key === '_' ? value[key] : redactAuthResponseValue(value[key], visited);
  });
  return redacted;
}

function redactAuthMessage(value: any) {
  return {
    ...value,
    ...('body' in value ? {body: '[REDACTED]'} : {}),
    ...('token' in value ? {token: '[REDACTED]'} : {}),
    ...('params' in value ? {params: '[REDACTED]'} : {}),
    ...('query' in value ? {query: '[REDACTED]'} : {})
  };
}

function redactAuthLogValue(value: any, sentMessages: NetworkerWithLogger['sentMessages'], authContext: boolean): any {
  if(!value || typeof value !== 'object') return value;
  if(isNetworkerLogValue(value)) {
    return {
      type: 'MTPNetworker',
      transportAvailable: !!value.transport,
      pendingMessageCount: Object.keys(value.sentMessages).length
    };
  }

  if(value instanceof Error && authContext) {
    const errorType = (value as Error & {type?: string}).type;
    return typeof errorType === 'string' ? {type: errorType} : {name: value.name};
  }
  if(authContext && typeof value.type === 'string' && ('message' in value || 'code' in value || 'originalError' in value)) {
    return {type: value.type};
  }

  if(isAuthRequest(value)) return redactAuthMessage(value);

  if(value.container && containsAuthRequest(value, sentMessages)) return {...value, body: '[REDACTED]'};

  if(authContext && value._ === 'message' && containsAuthRequest(value.body, sentMessages)) {
    return {...value, body: redactAuthLogValue(value.body, sentMessages, true)};
  }

  if(authContext && typeof value._ === 'string' && value._.startsWith('auth.')) {
    return redactAuthResponseValue(value);
  }

  if(value._ === 'rpc_error' && authContext) {
    return {...value, error_message: '[REDACTED]'};
  }

  if(value._ === 'rpc_result' && containsAuthRequest(value, sentMessages)) {
    return {...value, result: redactAuthLogValue(value.result, sentMessages, true)};
  }

  if(value._ === 'msg_container' && Array.isArray(value.messages) && containsAuthRequest(value, sentMessages)) {
    return {...value, messages: value.messages.map((message: any) => redactAuthLogValue(message, sentMessages, true))};
  }

  if(Array.isArray(value)) {
    return value.map((item) => redactAuthLogValue(item, sentMessages, authContext));
  }

  return value;
}

function redactAuthLogArgs(args: any[], sentMessages: NetworkerWithLogger['sentMessages']) {
  const hasAuthRequest = args.some((value) => containsAuthRequest(value, sentMessages));
  const authCallArgs = redactAuthCallArgs(args);

  return authCallArgs.map((value, index) => index === 0 ? value : redactAuthLogValue(value, sentMessages, hasAuthRequest));
}

function wrapAuthNetworkerLogger(boundLogger: Logger, sentMessages: NetworkerWithLogger['sentMessages']): Logger {
  return new Proxy(boundLogger, {
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg, redactAuthLogArgs(args, sentMessages));
    },
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if(typeof member !== 'function') return member;

      if(property === 'bindPrefix') {
        return (...args: any[]) => wrapAuthNetworkerLogger(Reflect.apply(member, target, args), sentMessages);
      }

      return (...args: any[]) => Reflect.apply(member, target, redactAuthLogArgs(args, sentMessages));
    }
  });
}

export function secureAuthNetworker(networker: MTPNetworker): MTPNetworker {
  if(redactedNetworkers.has(networker)) return networker;
  redactedNetworkers.add(networker);

  const authNetworker = networker as unknown as NetworkerWithLogger;
  authNetworker.log = wrapAuthNetworkerLogger(authNetworker.log, authNetworker.sentMessages);
  return networker;
}

type AuthLogRedaction = {
  originalError: Logger['error'],
  redactingError: Logger['error'],
  activeRequests: number
};

export class AuthLogRedactor {
  private redaction?: AuthLogRedaction;

  constructor(private readonly log: Pick<Logger, 'error'>) {}

  public begin() {
    if(this.redaction) {
      this.redaction.activeRequests++;
      return;
    }

    const originalError = this.log.error;
    const redactingError: Logger['error'] = (...args: any[]) => {
      const methodIndex = args[0] === 'Error' ? 5 : args[0] === 'Request is still processing:' ? 1 : -1;
      if(methodIndex !== -1 && getAuthMethod(args[methodIndex], args[methodIndex + 1])) {
        const redactedArgs = args.slice();
        redactedArgs[methodIndex + 1] = '[REDACTED]';
        return originalError(...redactedArgs);
      }

      return originalError(...args);
    };

    this.redaction = {originalError, redactingError, activeRequests: 1};
    this.log.error = redactingError;
  }

  public end() {
    const redaction = this.redaction;
    if(!redaction) return;

    redaction.activeRequests--;
    if(redaction.activeRequests !== 0) return;

    if(this.log.error === redaction.redactingError) this.log.error = redaction.originalError;
    this.redaction = undefined;
  }
}
