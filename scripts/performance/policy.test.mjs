import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluatePerformance, SCENARIOS} from './policy.mjs';

function samples(overrides = {}) {
  return Object.fromEntries(SCENARIOS.map(({key}) => [key, [{
    ms: 100,
    requests: 12,
    domNodes: 300,
    bundleBytes: 100_000,
    longTasksOver50Ms: 0,
    droppedFramePercent: 0,
    ...overrides[key]
  }, {
    ms: 100,
    requests: 12,
    domNodes: 300,
    bundleBytes: 100_000,
    longTasksOver50Ms: 0,
    droppedFramePercent: 0,
    ...overrides[key]
  }]]));
}

function report({base = samples(), head = samples()} = {}) {
  return {variants: {base, head}};
}

test('blocks a 100 ms main-thread task from the first run', () => {
  const metrics = samples({scrollBack2k: {longTasksOver50Ms: 1}});
  const result = evaluatePerformance(report({head: metrics}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('scrollBack2k') && failure.includes('long task')));
});

test('blocks scroll frame loss at one percent', () => {
  const metrics = samples({scrollBack2k: {droppedFramePercent: 1}});
  const result = evaluatePerformance(report({head: metrics}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('scrollBack2k') && failure.includes('dropped frames')));
});

test('does not apply the scroll long-task gate to other scenarios', () => {
  const metrics = samples({chatOpen: {longTasksOver50Ms: 2}});
  const result = evaluatePerformance(report({head: metrics}));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('chatOpen') && failure.includes('long task')), false);
});

test('reports timings without blocking until each scenario has 20 main runs', () => {
  const head = samples({dateJump: {ms: 1_400}});
  const history = Array.from({length: 19}, () => ({variants: {head: samples()}}));
  const result = evaluatePerformance(report({head}), history);

  assert.equal(result.calibratedScenarios, 0);
  assert.equal(result.blockingFailures.length, 0);
  assert.equal(result.rows.find((row) => row.key === 'coldChatList').budgetStatus, 'warming');
});

test('blocks fixed timing budgets before relative timing calibration', () => {
  const head = samples({coldChatList: {ms: 1_200}});
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('coldChatList') && failure.includes('1000 ms budget')));
  assert.equal(result.rows.find((row) => row.key === 'coldChatList').budgetStatus, 'failed');
});

test('blocks deterministic request increases against the same-run base', () => {
  const head = samples({globalSearch: {requests: 13}});
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('globalSearch') && failure.includes('requests')));
});

test('blocks an incomplete measurement instead of treating missing counters as zero', () => {
  const head = samples();
  head.chatOpen = [head.chatOpen[0]];
  delete head.chatOpen[0].requests;
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('chatOpen') && failure.includes('requests')));
  assert.ok(result.blockingFailures.some((failure) => failure.includes('chatOpen') && failure.includes('repeat')));
});

test('blocks bundle growth above two percent against the same-run base', () => {
  const head = samples({coldChatList: {bundleBytes: 102_001}});
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('bundle') && failure.includes('coldChatList')));
});

test('requires two repeated calibrated timing failures before blocking', () => {
  const historyMetric = {ms: 100};
  const history = Array.from({length: 20}, () => ({variants: {head: {dateJump: [historyMetric]}}}));
  const twoSlow = samples({dateJump: {ms: 220}});
  const result = evaluatePerformance(report({head: twoSlow}), history);

  assert.ok(result.blockingFailures.some((failure) => failure.includes('dateJump') && failure.includes('timing')));
});
