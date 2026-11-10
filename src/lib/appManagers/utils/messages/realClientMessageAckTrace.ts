export type MessageAckTraceSource = 'pushed' | 'difference' | 'local' | 'api_result';

type MessageAckTraceUpdate = {
  constructor: string,
  messageId?: number | string,
  randomIdMatches: boolean
};

type MessageAckTraceEvent = {
  kind: 'request',
  atMs: number,
  pendingTempId: number | string,
  peerKind: 'user' | 'chat' | 'channel'
} | {
  kind: 'send_result',
  atMs: number,
  updates: MessageAckTraceUpdate[]
} | {
  kind: 'update',
  atMs: number,
  source: Exclude<MessageAckTraceSource, 'local' | 'api_result'>,
  constructor: string,
  messageId?: number | string,
  randomIdMatches: boolean
} | {
  kind: 'pending_entry',
  atMs: number,
  found: boolean,
  pendingTempId?: number | string
} | {
  kind: 'message_sent',
  atMs: number,
  tempId: number | string,
  serverId?: number | string
};

export type MessageAcknowledgementTrace = {
  token: string,
  checkName: string | null,
  pendingEntryFound: boolean | null,
  messageSent: {
    emitted: boolean,
    tempId: number | string,
    serverId: number | string | null
  },
  events: MessageAckTraceEvent[]
};

type InternalTrace = {
  randomId: string,
  peerKey: string,
  startedAt: number,
  serverMessageIds: Set<string>,
  unmatchedUpdates: Array<{
    peerKey?: string,
    messageId: string,
    event: MessageAckTraceEvent
  }>,
  resultReceived: boolean,
  record: MessageAcknowledgementTrace
};

type TraceState = {
  tracesByRandomId: Map<string, InternalTrace>,
  records: MessageAcknowledgementTrace[],
  suppressedUpdateObservation: number,
  nextTraceToken: number,
  beginCalls: number,
  beginCallsByCheckName: Record<string, number>,
  rejectedReason: 'invalid_random_id' | 'invalid_pending_temp_id' | null
};

type TraceScope = typeof globalThis & {
  __realClientMessageAckTraceEnabled?: boolean,
  __realClientMessageAckTraceCheckName?: string,
  __realClientMessageAckTraceState?: TraceState
};

const TRACE_STATE = '__realClientMessageAckTraceState';
const TRACE_ENABLED = '__realClientMessageAckTraceEnabled';
const TRACE_CHECK_NAME = '__realClientMessageAckTraceCheckName';

function getTraceScope() {
  return globalThis as TraceScope;
}

function getEnabledTraceScope() {
  const scope = getTraceScope();
  return scope[TRACE_ENABLED] === true ? scope : undefined;
}

function getTraceState(create: boolean): TraceState | undefined {
  const scope = getEnabledTraceScope();
  if(!scope) return undefined;

  if(!scope[TRACE_STATE] && create) {
    Object.defineProperty(scope, TRACE_STATE, {
      value: {
        tracesByRandomId: new Map(),
        records: [],
        suppressedUpdateObservation: 0,
        nextTraceToken: 0,
        beginCalls: 0,
        beginCallsByCheckName: {},
        rejectedReason: null
      },
      configurable: true
    });
  }

  return scope[TRACE_STATE];
}

function safeId(value: unknown): number | string | undefined {
  if(typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if(typeof value !== 'string' && typeof value !== 'bigint') return undefined;

  const id = String(value);
  return /^-?[0-9]{1,24}(?:\.[0-9]{1,4})?$/.test(id) ? id : undefined;
}

function safeRandomId(value: unknown): string | undefined {
  const randomId = safeId(value);
  return randomId === undefined ? undefined : String(randomId);
}

function getNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(trace: InternalTrace) {
  return Math.max(0, Math.round(getNow() - trace.startedAt));
}

function getMessageId(update: any): number | string | undefined {
  if(update?._ === 'updateMessageID' || update?._ === 'updateShortSentMessage') {
    return safeId(update.id);
  }

  return safeId(update?.message?.id ?? update?.message?.mid);
}

function getUpdateRandomId(update: any) {
  return safeRandomId(update?.random_id ?? update?.message?.random_id);
}

function normalizeUpdate(update: any, randomId: string): MessageAckTraceUpdate {
  const constructor = typeof update?._ === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(update._) ? update._ : 'unknown';
  const messageId = getMessageId(update);
  return {
    constructor,
    ...(messageId === undefined ? {} : {messageId}),
    randomIdMatches: getUpdateRandomId(update) === randomId
  };
}

function getCheckName() {
  const value = getEnabledTraceScope()?.[TRACE_CHECK_NAME];
  return typeof value === 'string' && /^[a-z0-9_]{1,96}$/.test(value) ? value : null;
}

export function enableRealClientMessageAckTrace() {
  getTraceScope()[TRACE_ENABLED] = true;
  getTraceState(true);
}

export function setRealClientMessageAckTraceCheckName(checkName: string) {
  if(!/^[a-z0-9_]{1,96}$/.test(checkName)) return false;
  getTraceScope()[TRACE_CHECK_NAME] = checkName;
  return true;
}

export function getRealClientMessageAckTraceSnapshot() {
  const scope = getTraceScope();
  const state = scope[TRACE_STATE];
  return {
    switchEnabled: scope[TRACE_ENABLED] === true,
    stateExists: !!state,
    beginCalls: state?.beginCalls ?? 0,
    rejectedReason: state?.rejectedReason ?? (scope[TRACE_ENABLED] === true ? null : 'switch_disabled'),
    beginCallsByCheckName: state ? {...state.beginCallsByCheckName} : {},
    records: state ? [...state.records] : []
  };
}

function hashRandomId(randomId: string) {
  let hash = 2166136261;
  for(let index = 0; index < randomId.length; ++index) {
    hash = Math.imul(hash ^ randomId.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function appendUnmatchedUpdates(trace: InternalTrace) {
  for(const candidate of trace.unmatchedUpdates) {
    if((candidate.peerKey === undefined || candidate.peerKey === trace.peerKey) && trace.serverMessageIds.has(candidate.messageId)) {
      trace.record.events.push(candidate.event);
    }
  }
  trace.unmatchedUpdates = [];
}

export function beginMessageAcknowledgementTrace(options: {
  randomId: unknown,
  pendingTempId: unknown,
  peerKind: 'user' | 'chat' | 'channel',
  peerKey: unknown
}) {
  const state = getTraceState(true);
  if(!state) return undefined;
  state.beginCalls++;
  const checkName = getCheckName();
  if(checkName) {
    state.beginCallsByCheckName[checkName] = (state.beginCallsByCheckName[checkName] || 0) + 1;
  }

  const randomId = safeRandomId(options.randomId);
  if(randomId === undefined) {
    state.rejectedReason = 'invalid_random_id';
    return undefined;
  }

  const pendingTempId = safeId(options.pendingTempId);
  if(pendingTempId === undefined) {
    state.rejectedReason = 'invalid_pending_temp_id';
    return undefined;
  }

  state.rejectedReason = null;

  const existingTrace = state.tracesByRandomId.get(randomId);
  if(existingTrace) return existingTrace;

  const record: MessageAcknowledgementTrace = {
    token: `send-${++state.nextTraceToken}-${hashRandomId(randomId)}`,
    checkName: getCheckName(),
    pendingEntryFound: null,
    messageSent: {emitted: false, tempId: pendingTempId, serverId: null},
    events: []
  };
  const trace: InternalTrace = {
    randomId,
    peerKey: String(options.peerKey),
    startedAt: getNow(),
    serverMessageIds: new Set(),
    unmatchedUpdates: [],
    resultReceived: false,
    record
  };

  record.events.push({
    kind: 'request',
    atMs: 0,
    pendingTempId,
    peerKind: options.peerKind
  });
  state.tracesByRandomId.set(randomId, trace);
  state.records.push(record);
  return trace;
}

export function recordMessageAcknowledgementResult(randomIdValue: unknown, result: any) {
  const state = getTraceState(false);
  const randomId = safeRandomId(randomIdValue);
  const trace = randomId === undefined ? undefined : state?.tracesByRandomId.get(randomId);
  if(!state || !trace) return;

  const rawUpdates: any[] = Array.isArray(result?.updates) ? result.updates : [result];
  const updates = rawUpdates.map((update) => normalizeUpdate(update, randomId));
  rawUpdates.forEach((update, index) => {
    const messageId = updates[index].messageId;
    if(messageId === undefined) return;
    if(updates[index].randomIdMatches || update?._ === 'updateNewMessage' || update?._ === 'updateNewChannelMessage' || update?._ === 'updateNewDiscussionMessage' || update?._ === 'updateShortSentMessage' || update?.message) {
      trace.serverMessageIds.add(String(messageId));
    }
  });

  appendUnmatchedUpdates(trace);
  trace.resultReceived = true;
  trace.record.events.push({kind: 'send_result', atMs: elapsedMs(trace), updates});
}

export function recordMessageAcknowledgementUpdate(update: any, source: MessageAckTraceSource, peerKey?: unknown) {
  if(source === 'local' || source === 'api_result') return;

  const state = getTraceState(false);
  if(!state || state.suppressedUpdateObservation > 0) return;

  const randomId = getUpdateRandomId(update);
  const messageId = getMessageId(update);
  if(randomId === undefined && messageId === undefined) return;
  const peerKeyValue = peerKey === undefined ? undefined : String(peerKey);
  const constructor = typeof update?._ === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(update._) ? update._ : 'unknown';

  state.tracesByRandomId.forEach((trace) => {
    const randomIdMatches = randomId === trace.randomId;
    const messageIdValue = messageId === undefined ? undefined : String(messageId);
    const messageIdMatches = messageIdValue !== undefined && trace.serverMessageIds.has(messageIdValue) &&
      (peerKeyValue === undefined || peerKeyValue === trace.peerKey);
    const event: MessageAckTraceEvent = {
      kind: 'update',
      atMs: elapsedMs(trace),
      source,
      constructor,
      ...(messageId === undefined ? {} : {messageId}),
      randomIdMatches
    };

    if(randomIdMatches || messageIdMatches) {
      trace.record.events.push(event);
      if(randomIdMatches && messageIdValue !== undefined) trace.serverMessageIds.add(messageIdValue);
    } else if(!trace.resultReceived && messageIdValue !== undefined &&
        (peerKeyValue === trace.peerKey || peerKeyValue === undefined && update?._ === 'updateMessageID')) {
      trace.unmatchedUpdates.push({peerKey: peerKeyValue, messageId: messageIdValue, event});
    }
  });
}

export function recordMessageAcknowledgementPendingEntry(randomIdValue: unknown, pendingData: {tempId?: unknown} | undefined) {
  const state = getTraceState(false);
  const randomId = safeRandomId(randomIdValue);
  const trace = randomId === undefined ? undefined : state?.tracesByRandomId.get(randomId);
  if(!trace) return;

  const pendingTempId = pendingData ? safeId(pendingData.tempId) : undefined;
  const found = !!pendingData;
  trace.record.pendingEntryFound = found;
  trace.record.events.push({
    kind: 'pending_entry',
    atMs: elapsedMs(trace),
    found,
    ...(found && pendingTempId !== undefined ? {pendingTempId} : {})
  });
}

export function recordMessageAcknowledgementSent(randomIdValue: unknown, tempIdValue: unknown, serverIdValue: unknown) {
  const state = getTraceState(false);
  const randomId = safeRandomId(randomIdValue);
  const trace = randomId === undefined ? undefined : state?.tracesByRandomId.get(randomId);
  const tempId = safeId(tempIdValue);
  const serverId = safeId(serverIdValue);
  if(!trace || tempId === undefined) return;

  trace.record.messageSent = {
    emitted: true,
    tempId,
    serverId: serverId ?? null
  };
  trace.record.events.push({
    kind: 'message_sent',
    atMs: elapsedMs(trace),
    tempId,
    ...(serverId === undefined ? {} : {serverId})
  });
}

export function withMessageAcknowledgementUpdateObservationSuppressed<T>(callback: () => T): T {
  const state = getTraceState(false);
  if(!state) return callback();

  state.suppressedUpdateObservation++;
  try {
    return callback();
  } finally {
    state.suppressedUpdateObservation--;
  }
}
