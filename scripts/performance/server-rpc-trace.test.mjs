import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {getServerRpcTracePosition, readServerRpcTraceRecordsSince, serverRpcIntervalUnionMs, serverRpcTraceExpectation, waitForServerRpcTraceRecords} from './server-rpc-trace.mjs';

const record = (method, duration_us = 40_123) => JSON.stringify({
  method,
  duration_us,
  result: 'success',
  end_unix_ms: 1_762_800_000_123
});

test('server RPC trace keeps a required record when the client sample has no calls', () => {
  assert.deepEqual(serverRpcTraceExpectation(0), {minimumCount: 1});
  assert.deepEqual(serverRpcTraceExpectation(undefined), {minimumCount: 1});
});

test('server RPC trace requires coverage for each client call without dropping extra handlers', () => {
  assert.deepEqual(serverRpcTraceExpectation(2), {minimumCount: 2});
});

test('server RPC interval union does not double count overlapping handlers', () => {
  assert.equal(serverRpcIntervalUnionMs([
    {duration_us: 40_000, end_unix_ms: 1_000},
    {duration_us: 40_000, end_unix_ms: 1_010}
  ]), 50);
});

async function withTraceFile(run) {
  const directory = mkdtempSync(join(tmpdir(), 'tweb-server-rpc-trace-'));
  const path = join(directory, 'trace.jsonl');
  writeFileSync(path, '');
  try {
    return await run(path);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

test('server RPC trace reads complete appended records after a byte offset', () => withTraceFile((path) => {
  writeFileSync(path, `${record('messages.getHistory')}\n${record('messages.sendMessage')}\n`);
  const offset = getServerRpcTracePosition(path);
  appendFileSync(path, `${record('messages.getHistory', 9_000)}\n${record('messages.getHistory', 1_000)}`);

  assert.deepEqual(readServerRpcTraceRecordsSince(path, offset), [
    {method: 'messages.getHistory', duration_us: 9_000, result: 'success', end_unix_ms: 1_762_800_000_123}
  ]);

  appendFileSync(path, '\n');
  assert.deepEqual(readServerRpcTraceRecordsSince(path, offset), [
    {method: 'messages.getHistory', duration_us: 9_000, result: 'success', end_unix_ms: 1_762_800_000_123},
    {method: 'messages.getHistory', duration_us: 1_000, result: 'success', end_unix_ms: 1_762_800_000_123}
  ]);
}));

test('server RPC trace waits for all matching records and ignores other methods', async() => withTraceFile(async(path) => {
  const offset = getServerRpcTracePosition(path);
  const pending = waitForServerRpcTraceRecords(path, offset, 'messages.getHistory', 2, {
    timeoutMs: 500,
    pollIntervalMs: 2,
    quietMs: 5
  });
  appendFileSync(path, `${record('messages.sendMessage')}\n`);
  setTimeout(() => appendFileSync(path, `${record('messages.getHistory', 9_000)}\n`), 10);
  setTimeout(() => appendFileSync(path, `${record('messages.getHistory', 1_000)}\n`), 20);

  assert.deepEqual(await pending, [
    {method: 'messages.getHistory', duration_us: 9_000, result: 'success', end_unix_ms: 1_762_800_000_123},
    {method: 'messages.getHistory', duration_us: 1_000, result: 'success', end_unix_ms: 1_762_800_000_123}
  ]);
}));

test('server RPC trace rejects invalid offsets and malformed complete records', () => withTraceFile((path) => {
  assert.throws(() => readServerRpcTraceRecordsSince(path, -1), /non-negative safe integer/);
  appendFileSync(path, '{bad json}\n');
  assert.throws(() => readServerRpcTraceRecordsSince(path, 0), /parse RPC trace record/);
}));
