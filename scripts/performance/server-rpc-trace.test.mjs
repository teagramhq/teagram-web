import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {clientRpcIntervalUnionMs, getServerRpcTracePosition, readServerRpcTraceRecordsSince, serverRpcIntervalUnionMs, serverRpcTraceExpectation, waitForServerRpcTraceRecords} from './server-rpc-trace.mjs';

const record = (method, duration_us = 40_123) => JSON.stringify({
  method,
  duration_us,
  result: 'success',
  end_unix_ms: 1_762_800_000_123
});

test('server RPC trace expects no records when the client sample issued no calls', () => {
  assert.deepEqual(serverRpcTraceExpectation(0), {minimumCount: 0});
  assert.deepEqual(serverRpcTraceExpectation(undefined), {minimumCount: 1});
});

test('server RPC trace requires coverage for each client call without dropping extra handlers', () => {
  assert.deepEqual(serverRpcTraceExpectation(2), {minimumCount: 2});
});

test('server handler records must correlate to client spans in the chat-open sample', async() => {
  const {serverRpcRecordMatchesClientCalls, serverRpcRecordsCoverClientCalls} = await import('./server-rpc-trace.mjs');
  assert.equal(typeof serverRpcRecordMatchesClientCalls, 'function');
  assert.equal(typeof serverRpcRecordsCoverClientCalls, 'function');

  const recordValue = JSON.parse(record('messages.getHistory'));
  const clientCalls = [
    {method: 'messages.getHistory', startedAtEpochMs: 1_762_800_000_000, durationMs: 200, outcome: 'success'},
    {method: 'messages.getHistory', startedAtEpochMs: 1_762_800_000_000, durationMs: 200, outcome: 'success'}
  ];

  assert.equal(serverRpcRecordMatchesClientCalls(recordValue, clientCalls), true);
  assert.equal(serverRpcRecordMatchesClientCalls(recordValue, []), false);
  assert.equal(serverRpcRecordMatchesClientCalls({...recordValue, end_unix_ms: 1_762_800_000_500}, clientCalls), false);
  assert.equal(serverRpcRecordsCoverClientCalls([recordValue, recordValue], clientCalls), true);
  assert.equal(serverRpcRecordsCoverClientCalls([recordValue], clientCalls), false);

  const earlyRecord = {...recordValue, duration_us: 10_000, end_unix_ms: 1_762_800_000_115};
  const lateRecord = {...recordValue, duration_us: 10_000, end_unix_ms: 1_762_800_000_205};
  const broadCall = {method: 'messages.getHistory', startedAtEpochMs: 1_762_800_000_100, durationMs: 120, outcome: 'success'};
  const narrowCall = {method: 'messages.getHistory', startedAtEpochMs: 1_762_800_000_100, durationMs: 30, outcome: 'success'};
  assert.equal(serverRpcRecordsCoverClientCalls([earlyRecord, lateRecord], [broadCall, narrowCall]), true);
});

test('server RPC call identities reject a trace index that was remapped by reset', async() => {
  const {serverRpcClientCallsByIdentity} = await import('./server-rpc-trace.mjs');
  const boundaryCalls = [{callId: 1, startedAtEpochMs: 1_762_800_000_100}];
  const currentTrace = [
    {method: 'messages.sendMessage', startedAtEpochMs: 1_762_800_000_050, durationMs: 5, outcome: 'success'},
    {method: 'messages.getHistory', startedAtEpochMs: 1_762_800_000_100, durationMs: 200, outcome: 'success'}
  ];

  assert.deepEqual(serverRpcClientCallsByIdentity(currentTrace, boundaryCalls), [
    {...currentTrace[1], callId: 1}
  ]);

  const resetTrace = [
    {method: 'messages.sendMessage', startedAtEpochMs: 1_762_800_000_050, durationMs: 5, outcome: 'success'},
    {method: 'messages.getHistory', startedAtEpochMs: 1_762_800_000_900, durationMs: 200, outcome: 'success'}
  ];
  assert.throws(() => serverRpcClientCallsByIdentity(resetTrace, boundaryCalls), /trace identity changed for callId 1/);
});

test('server RPC interval union does not double count overlapping handlers', () => {
  assert.equal(serverRpcIntervalUnionMs([
    {duration_us: 40_000, end_unix_ms: 1_000},
    {duration_us: 40_000, end_unix_ms: 1_010}
  ]), 50);
});

test('client and server RPC interval unions clip to the chat-open gate boundary', () => {
  const gate = {startEpochMs: 100, endEpochMs: 200};
  const clientCalls = [
    {method: 'messages.getHistory', startedAtEpochMs: 80, durationMs: 70, outcome: 'success'},
    {method: 'messages.getHistory', startedAtEpochMs: 140, durationMs: 80, outcome: 'success'},
    {method: 'messages.getHistory', startedAtEpochMs: 210, durationMs: 10, outcome: 'success'}
  ];
  const serverRecords = [
    {method: 'messages.getHistory', duration_us: 60_000, result: 'success', end_unix_ms: 130},
    {method: 'messages.getHistory', duration_us: 40_000, result: 'success', end_unix_ms: 230},
    {method: 'messages.getHistory', duration_us: 30_000, result: 'success', end_unix_ms: 240}
  ];

  assert.equal(clientRpcIntervalUnionMs(clientCalls, gate), 100);
  assert.equal(clientRpcIntervalUnionMs(clientCalls.slice(2), gate), 0);
  assert.equal(serverRpcIntervalUnionMs(serverRecords, gate), 40);
  assert.equal(serverRpcIntervalUnionMs(serverRecords.slice(2), gate), 0);
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
