import {closeSync, openSync, readSync, statSync} from 'node:fs';

function traceFileStat(path) {
  try {
    const stat = statSync(path);
    if(!stat.isFile()) throw new Error('path is not a regular file');
    return stat;
  } catch(error) {
    throw new Error(`inspect RPC trace file ${path}: ${error.message}`, {cause: error});
  }
}

function validateOffset(offset) {
  if(!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('RPC trace byte offset must be a non-negative safe integer');
}

export function serverRpcTraceExpectation(clientRpcCount) {
  if(clientRpcCount === undefined) return {minimumCount: 1};
  if(!Number.isSafeInteger(clientRpcCount) || clientRpcCount < 0) throw new TypeError('client RPC count must be a non-negative safe integer');
  // A sample whose gate window issued no getHistory has nothing to wait for or attribute.
  return {minimumCount: clientRpcCount};
}

export const SERVER_RPC_TRACE_CLOCK_TOLERANCE_MS = 5;

export function serverRpcClientCallsAreSettled(calls) {
  return Array.isArray(calls) && calls.every((call) => (
    Number.isSafeInteger(call?.callId) && call.callId >= 0 &&
    call.method === 'messages.getHistory' && Number.isFinite(call.startedAtEpochMs) &&
    Number.isFinite(call.durationMs) && call.durationMs >= 0 &&
    ['success', 'error'].includes(call.outcome)
  ));
}

export function serverRpcClientCallsByIdentity(calls, identities) {
  if((!Array.isArray(calls) && (!calls || typeof calls !== 'object')) || !Array.isArray(identities)) {
    throw new TypeError('RPC trace calls must be an indexed object and boundary identities must be an array');
  }
  const seenCallIds = new Set();
  return identities.map(({callId, startedAtEpochMs}) => {
    if(!Number.isSafeInteger(callId) || callId < 0 || !Number.isFinite(startedAtEpochMs)) {
      throw new TypeError('RPC trace boundary identity requires a non-negative safe callId and finite startedAtEpochMs');
    }
    if(seenCallIds.has(callId)) throw new Error(`RPC trace boundary contains duplicate callId ${callId}`);
    seenCallIds.add(callId);
    const call = calls[callId];
    if(!call || call.startedAtEpochMs !== startedAtEpochMs) {
      throw new Error(`RPC trace identity changed for callId ${callId}: expected startedAtEpochMs ${startedAtEpochMs}, found ${call?.startedAtEpochMs ?? 'missing'}`);
    }
    return {...call, callId};
  });
}

export function serverRpcRecordMatchesClientCall(record, call) {
  if(record?.method !== 'messages.getHistory' ||
    !Number.isSafeInteger(record.duration_us) || record.duration_us < 0 ||
    !Number.isSafeInteger(record.end_unix_ms) || record.end_unix_ms <= 0 ||
    call?.method !== 'messages.getHistory' ||
    !Number.isFinite(call.startedAtEpochMs) ||
    !Number.isFinite(call.durationMs) || call.durationMs < 0 ||
    !['success', 'error'].includes(call.outcome)) return false;

  const serverStartEpochMs = record.end_unix_ms - record.duration_us / 1000;
  const clientEndEpochMs = call.startedAtEpochMs + call.durationMs;
  return serverStartEpochMs >= call.startedAtEpochMs - SERVER_RPC_TRACE_CLOCK_TOLERANCE_MS &&
    serverStartEpochMs <= clientEndEpochMs + SERVER_RPC_TRACE_CLOCK_TOLERANCE_MS &&
    record.end_unix_ms <= clientEndEpochMs + SERVER_RPC_TRACE_CLOCK_TOLERANCE_MS;
}

export function serverRpcRecordMatchesClientCalls(record, calls) {
  return Array.isArray(calls) && calls.some((call) => serverRpcRecordMatchesClientCall(record, call));
}

export function serverRpcRecordsCoverClientCalls(records, calls) {
  if(!Array.isArray(records) || !Array.isArray(calls) || !calls.length) return false;
  const callByRecordIndex = new Map();
  const assignRecord = (callIndex, visitedRecordIndexes) => {
    for(let recordIndex = 0; recordIndex < records.length; ++recordIndex) {
      if(visitedRecordIndexes.has(recordIndex) || !serverRpcRecordMatchesClientCall(records[recordIndex], calls[callIndex])) continue;
      visitedRecordIndexes.add(recordIndex);
      const previousCallIndex = callByRecordIndex.get(recordIndex);
      if(previousCallIndex === undefined || assignRecord(previousCallIndex, visitedRecordIndexes)) {
        callByRecordIndex.set(recordIndex, callIndex);
        return true;
      }
    }
    return false;
  };
  return calls.every((_, callIndex) => assignRecord(callIndex, new Set()));
}

function validateIntervalWindow(window) {
  if(!window || !Number.isFinite(window.startEpochMs) || !Number.isFinite(window.endEpochMs) || window.endEpochMs <= window.startEpochMs) {
    throw new TypeError('RPC interval window requires finite startEpochMs and endEpochMs with end after start');
  }
}

function intervalUnionMs(intervals) {
  const nonEmptyIntervals = intervals.filter(({end, start}) => end > start).sort((left, right) => left.start - right.start);
  let intervalUnionMs = 0;
  let intervalStart = -1;
  let intervalEnd = -1;
  for(const interval of nonEmptyIntervals) {
    if(interval.start > intervalEnd) {
      intervalUnionMs += intervalEnd - intervalStart;
      intervalStart = interval.start;
      intervalEnd = interval.end;
    } else {
      intervalEnd = Math.max(intervalEnd, interval.end);
    }
  }
  intervalUnionMs += intervalEnd - intervalStart;
  return Math.max(0, intervalUnionMs);
}

function clipInterval(interval, window) {
  if(!window) return interval;
  return {
    start: Math.max(interval.start, window.startEpochMs),
    end: Math.min(interval.end, window.endEpochMs)
  };
}

export function serverRpcIntervalUnionMs(records, window) {
  if(!Array.isArray(records)) throw new TypeError('RPC trace records must be an array');
  if(window) validateIntervalWindow(window);
  const intervals = records.map(({duration_us, end_unix_ms}) => {
    if(!Number.isSafeInteger(duration_us) || duration_us < 0 || !Number.isSafeInteger(end_unix_ms) || end_unix_ms <= 0) {
      throw new TypeError('RPC trace interval requires a non-negative duration_us and positive end_unix_ms');
    }
    return clipInterval({start: end_unix_ms - duration_us / 1000, end: end_unix_ms}, window);
  });
  return intervalUnionMs(intervals);
}

export function clientRpcIntervalUnionMs(calls, window) {
  if(!Array.isArray(calls)) throw new TypeError('client RPC calls must be an array');
  validateIntervalWindow(window);
  const intervals = calls.map(({method, startedAtEpochMs, durationMs, outcome}) => {
    if(method !== 'messages.getHistory' || !Number.isFinite(startedAtEpochMs) || !Number.isFinite(durationMs) || durationMs < 0 || !['success', 'error'].includes(outcome)) {
      throw new TypeError('client RPC interval requires a completed messages.getHistory call');
    }
    return clipInterval({start: startedAtEpochMs, end: startedAtEpochMs + durationMs}, window);
  });
  return intervalUnionMs(intervals);
}

/** @typedef {{method: string, duration_us: number, result: string, end_unix_ms: number}} ServerRpcTraceRecord */

/** @returns {ServerRpcTraceRecord} */
function parseRecord(line, index) {
  let record;
  try {
    record = JSON.parse(line);
  } catch(error) {
    throw new Error(`parse RPC trace record ${index + 1}: ${error.message}`, {cause: error});
  }
  if(!record || typeof record !== 'object' || Array.isArray(record) ||
    typeof record.method !== 'string' || !record.method ||
    !Number.isSafeInteger(record.duration_us) || record.duration_us < 0 ||
    typeof record.result !== 'string' || !record.result ||
    !Number.isSafeInteger(record.end_unix_ms) || record.end_unix_ms <= 0) {
    throw new Error(`validate RPC trace record ${index + 1}: expected method, non-negative duration_us, result, and end_unix_ms`);
  }
  return record;
}

export function getServerRpcTracePosition(path) {
  return traceFileStat(path).size;
}

/** @returns {ServerRpcTraceRecord[]} */
export function readServerRpcTraceRecordsSince(path, offset) {
  validateOffset(offset);
  const size = traceFileStat(path).size;
  if(size < offset) throw new Error(`RPC trace file ${path} shrank during a sample`);
  if(size === offset) return [];

  const descriptor = openSync(path, 'r');
  let bytesRead = 0;
  const contents = Buffer.alloc(size - offset);
  try {
    while(bytesRead < contents.length) {
      const count = readSync(descriptor, contents, bytesRead, contents.length - bytesRead, offset + bytesRead);
      if(count === 0) break;
      bytesRead += count;
    }
  } catch(error) {
    throw new Error(`read RPC trace file ${path}: ${error.message}`, {cause: error});
  } finally {
    closeSync(descriptor);
  }

  const completeBytes = contents.subarray(0, bytesRead);
  const lastNewline = completeBytes.lastIndexOf(0x0a);
  if(lastNewline < 0) return [];
  const lines = completeBytes.subarray(0, lastNewline).toString('utf8').split('\n');
  return lines.map((line, index) => parseRecord(line, index));
}

/**
 * @param {string} path
 * @param {number} offset
 * @param {string} method
 * @param {number} minimumCount
 * @param {{timeoutMs?: number, pollIntervalMs?: number, quietMs?: number, recordFilter?: (record: ServerRpcTraceRecord) => boolean}} [options]
 * @returns {Promise<ServerRpcTraceRecord[]>}
 */
export async function waitForServerRpcTraceRecords(path, offset, method, minimumCount, {
  timeoutMs = 5_000,
  pollIntervalMs = 20,
  quietMs = 25,
  recordFilter = () => true
} = {}) {
  if(typeof method !== 'string' || !method) throw new TypeError('RPC trace method must be non-empty');
  if(!Number.isSafeInteger(minimumCount) || minimumCount < 1) throw new TypeError('RPC trace minimum count must be a positive safe integer');
  if(!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('RPC trace timeout must be positive');
  if(!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new TypeError('RPC trace poll interval must be positive');
  if(!Number.isFinite(quietMs) || quietMs < 0) throw new TypeError('RPC trace quiet period cannot be negative');
  if(typeof recordFilter !== 'function') throw new TypeError('RPC trace record filter must be a function');

  const deadline = Date.now() + timeoutMs;
  let matchingRecords = [];
  let lastCount = 0;
  let lastMatchingCount = 0;
  let lastChangeAt;
  do {
    const methodRecords = readServerRpcTraceRecordsSince(path, offset).filter((record) => record.method === method);
    matchingRecords = methodRecords.filter(recordFilter);
    if(methodRecords.length !== lastCount) {
      lastCount = methodRecords.length;
      lastChangeAt = Date.now();
    }
    if(matchingRecords.length >= minimumCount) {
      if(matchingRecords.length !== lastMatchingCount) {
        lastMatchingCount = matchingRecords.length;
        lastChangeAt = Date.now();
      }
      if(Date.now() - lastChangeAt >= quietMs) return matchingRecords;
    }
    if(Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while(true);

  throw new Error(`timed out waiting for ${minimumCount} ${method} RPC trace record(s) in ${path}; found ${matchingRecords.length}`);
}
