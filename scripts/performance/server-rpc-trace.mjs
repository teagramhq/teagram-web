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

export async function waitForServerRpcTraceRecords(path, offset, method, minimumCount, {
  timeoutMs = 5_000,
  pollIntervalMs = 20,
  quietMs = 25
} = {}) {
  if(typeof method !== 'string' || !method) throw new TypeError('RPC trace method must be non-empty');
  if(!Number.isSafeInteger(minimumCount) || minimumCount < 1) throw new TypeError('RPC trace minimum count must be a positive safe integer');
  if(!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('RPC trace timeout must be positive');
  if(!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new TypeError('RPC trace poll interval must be positive');
  if(!Number.isFinite(quietMs) || quietMs < 0) throw new TypeError('RPC trace quiet period cannot be negative');

  const deadline = Date.now() + timeoutMs;
  let matchingRecords = [];
  let lastCount = 0;
  let lastChangeAt;
  do {
    matchingRecords = readServerRpcTraceRecordsSince(path, offset).filter((record) => record.method === method);
    if(matchingRecords.length >= minimumCount) {
      if(matchingRecords.length !== lastCount) {
        lastCount = matchingRecords.length;
        lastChangeAt = Date.now();
      }
      if(Date.now() - lastChangeAt >= quietMs) return matchingRecords;
    }
    if(Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while(true);

  throw new Error(`timed out waiting for ${minimumCount} ${method} RPC trace record(s) in ${path}; found ${matchingRecords.length}`);
}
