import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluatePerformance, formatPerformanceTable, SCENARIOS} from './policy.mjs';

const SCALES = ['1x', '100x'];
const CURRENT_FIXTURE = {
  measurementVersion: 2,
  fixtureVersion: 'fixture-v1',
  serverCommit: 'runtime-server-v1',
  fixtureServerCommit: 'fixture-server-v1'
};

function scaleSamples(overrides = {}) {
  return Object.fromEntries(SCENARIOS.map(({key}) => {
    const override = overrides[key];
    const values = Array.isArray(override) ? override : [override, override, override];
    return [key, values.map((sample) => ({
      ms: 100,
      requests: 12,
      domNodes: 300,
      bundleBytes: 100_000,
      longTasksOver50Ms: 0,
      blockingTimeMs: 0,
      maxLongTaskDurationMs: 0,
      frameIntervals: 100,
      droppedFrames: 0,
      droppedFramePercent: 0,
      ...sample
    }))];
  }));
}

function scaleVariants(overrides = {}) {
  return {
    '1x': scaleSamples(overrides['1x']),
    '100x': scaleSamples(overrides['100x'])
  };
}

function report({base = scaleVariants(), head = scaleVariants(), requireBase = true, ...metadata} = {}) {
  return {
    ...CURRENT_FIXTURE,
    ...metadata,
    requireBase,
    variants: {base, head}
  };
}

function mainHistory(count = 20, overrides = {}, metadata = CURRENT_FIXTURE) {
  const head = scaleVariants(overrides);
  return Array.from({length: count}, () => ({...metadata, variants: {head}}));
}

function cleanScrollSamples() {
  return Array.from({length: 3}, () => ({
    longTasksOver50Ms: 0,
    blockingTimeMs: 0,
    maxLongTaskDurationMs: 0,
    droppedFrames: 0,
    frameIntervals: 100,
    droppedFramePercent: 0
  }));
}

function scrollHistory(count = 20, samples = cleanScrollSamples()) {
  return mainHistory(count, {'100x': {scrollBack2k: samples}});
}

test('blocks a 100 ms main-thread task on 100x cold load from the first run', () => {
  const head = scaleVariants({
    '1x': {coldChatList: {longTasksOver50Ms: 1}},
    '100x': {coldChatList: {longTasksOver50Ms: 1}}
  });
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x') && failure.includes('coldChatList') && failure.includes('long task')));
  assert.equal(result.blockingFailures.some((failure) => failure.includes('1x coldChatList') && failure.includes('long task')), false);
});

test('blocks an added 100 ms task when the 100x cold-load base already has long tasks', () => {
  const base = scaleVariants({'100x': {coldChatList: [
    {longTasksOver50Ms: 3, blockingTimeMs: 140, maxLongTaskDurationMs: 118},
    {longTasksOver50Ms: 3, blockingTimeMs: 134, maxLongTaskDurationMs: 119},
    {longTasksOver50Ms: 3, blockingTimeMs: 140, maxLongTaskDurationMs: 119}
  ]}});
  const head = scaleVariants({'100x': {coldChatList: [
    {longTasksOver50Ms: 4, blockingTimeMs: 190, maxLongTaskDurationMs: 118},
    {longTasksOver50Ms: 4, blockingTimeMs: 184, maxLongTaskDurationMs: 119},
    {longTasksOver50Ms: 4, blockingTimeMs: 190, maxLongTaskDurationMs: 119}
  ]}});
  const result = evaluatePerformance(report({base, head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x coldChatList') && failure.includes('long task')));
});

test('reports 100x scroll frame loss during master calibration', () => {
  const head = scaleVariants({
    '1x': {scrollBack2k: {droppedFrames: 50, frameIntervals: 950, droppedFramePercent: 5}},
    '100x': {scrollBack2k: {droppedFrames: 2, frameIntervals: 198, droppedFramePercent: 1}}
  });
  const result = evaluatePerformance(report({head}));

  const row = result.rows.find((item) => item.scale === '100x' && item.key === 'scrollBack2k');
  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k')), false);
  assert.equal(row.scrollHistoryRuns, 0);
  assert.match(row.scrollGateStatus, /report only.*0\/20/);
});

test('pools dropped frame counts across all scroll repeats', () => {
  const head = scaleVariants({'100x': {scrollBack2k: [
    {droppedFrames: 4, frameIntervals: 774, droppedFramePercent: 0.5141388174807198},
    {droppedFrames: 9, frameIntervals: 881, droppedFramePercent: 1.0112359550561798},
    {droppedFrames: 8, frameIntervals: 767, droppedFramePercent: 1.032258064516129}
  ]}});
  const result = evaluatePerformance(report({head}));
  const row = result.rows.find((item) => item.scale === '100x' && item.key === 'scrollBack2k');

  assert.ok(row.head.droppedFramePercent < 1);
  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('dropped frames')), false);
});

test('fails closed when scroll frame counters are missing', () => {
  const head = scaleVariants();
  delete head['100x'].scrollBack2k[1].frameIntervals;
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('frame interval count is missing')));
});

test('reports a lone 100x scroll task against a base that misses absolute limits', () => {
  const base = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 10, droppedFrames: 202, frameIntervals: 865, droppedFramePercent: 18.93},
    {longTasksOver50Ms: 0, droppedFrames: 2, frameIntervals: 701, droppedFramePercent: 0.28},
    {longTasksOver50Ms: 0, droppedFrames: 2, frameIntervals: 755, droppedFramePercent: 0.26}
  ]}});
  const head = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 1},
    {longTasksOver50Ms: 0},
    {longTasksOver50Ms: 0}
  ]}});
  const result = evaluatePerformance(report({base, head}));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('long task')), false);
});

test('reports repeated 100x scroll long tasks during master calibration', () => {
  const head = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 1},
    {longTasksOver50Ms: 1},
    {longTasksOver50Ms: 0}
  ]}});
  const result = evaluatePerformance(report({head}));
  const row = result.rows.find((item) => item.scale === '100x' && item.key === 'scrollBack2k');

  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k')), false);
  assert.match(row.scrollGateStatus, /report only.*0\/20/);
});

test('blocks new long tasks across 100x scenarios', () => {
  for(const {key} of SCENARIOS) {
    const base = scaleVariants({'100x': {[key]: [
      {longTasksOver50Ms: 1},
      {longTasksOver50Ms: 1},
      {longTasksOver50Ms: 0}
    ]}});
    const head = scaleVariants({'100x': {[key]: [
      {longTasksOver50Ms: 2},
      {longTasksOver50Ms: 2},
      {longTasksOver50Ms: 2}
    ]}});
    const history = key === 'scrollBack2k' ? scrollHistory() : [];
    const result = evaluatePerformance(report({base, head}), history);

    assert.ok(result.blockingFailures.some((failure) => failure.includes(`100x ${key}`) && failure.includes('long task')));
  }
});

test('allows send-message task noise when the corresponding base repeat is worse', () => {
  const base = scaleVariants({'100x': {sendMessage: [
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0},
    {longTasksOver50Ms: 4, blockingTimeMs: 68, maxLongTaskDurationMs: 82}
  ]}});
  const head = scaleVariants({'100x': {sendMessage: [
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0},
    {longTasksOver50Ms: 1, blockingTimeMs: 14, maxLongTaskDurationMs: 64},
    {longTasksOver50Ms: 1, blockingTimeMs: 27, maxLongTaskDurationMs: 77}
  ]}});
  const result = evaluatePerformance(report({base, head}));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x sendMessage') && /long task|blocking time/.test(failure)), false);
});

test('allows existing 100x base long tasks when the head count does not grow', () => {
  const base = scaleVariants({'100x': {coldChatList: [
    {longTasksOver50Ms: 1},
    {longTasksOver50Ms: 0},
    {longTasksOver50Ms: 1}
  ]}});
  const head = scaleVariants({'100x': {coldChatList: [
    {longTasksOver50Ms: 0},
    {longTasksOver50Ms: 1},
    {longTasksOver50Ms: 1}
  ]}});
  const result = evaluatePerformance(report({base, head}));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x coldChatList') && failure.includes('long task')), false);
});

test('allows head chat-open task noise that stays inside the same-run base repeats', () => {
  const base = scaleVariants({'100x': {chatOpen: [
    {longTasksOver50Ms: 2, blockingTimeMs: 165, maxLongTaskDurationMs: 206},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0}
  ]}});
  const head = scaleVariants({'100x': {chatOpen: [
    {longTasksOver50Ms: 1, blockingTimeMs: 6, maxLongTaskDurationMs: 56},
    {longTasksOver50Ms: 1, blockingTimeMs: 3, maxLongTaskDurationMs: 53},
    {longTasksOver50Ms: 1, blockingTimeMs: 7, maxLongTaskDurationMs: 57}
  ]}});
  const result = evaluatePerformance(report({base, head}));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x chatOpen')), false);
});

test('blocks an added 100 ms task by blocking time when base task counts vary', () => {
  const base = scaleVariants({'100x': {coldChatList: [
    {longTasksOver50Ms: 2, blockingTimeMs: 70},
    {longTasksOver50Ms: 3, blockingTimeMs: 134},
    {longTasksOver50Ms: 3, blockingTimeMs: 147}
  ]}});
  const head = scaleVariants({'100x': {coldChatList: [
    {longTasksOver50Ms: 3, blockingTimeMs: 184},
    {longTasksOver50Ms: 4, blockingTimeMs: 186},
    {longTasksOver50Ms: 4, blockingTimeMs: 198}
  ]}});
  const result = evaluatePerformance(report({base, head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x coldChatList') && failure.includes('blocking time')));
});

test('allows one 100x contacts long-task and blocking-time outlier', () => {
  const head = scaleVariants({'100x': {contactsList: [
    {longTasksOver50Ms: 1, blockingTimeMs: 126, maxLongTaskDurationMs: 176},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0}
  ]}});
  const result = evaluatePerformance(report({head}));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x contactsList') && /long task|blocking time/.test(failure)), false);
});

test('reports scroll misses while master calibration warms up', () => {
  const base = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 10, blockingTimeMs: 35, maxLongTaskDurationMs: 60, droppedFrames: 202, frameIntervals: 865, droppedFramePercent: 18.93},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0, droppedFrames: 2, frameIntervals: 701, droppedFramePercent: 0.28},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0, droppedFrames: 2, frameIntervals: 755, droppedFramePercent: 0.26}
  ]}});
  const head = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 0, blockingTimeMs: 0, droppedFrames: 0, frameIntervals: 100, droppedFramePercent: 0},
    {longTasksOver50Ms: 6, blockingTimeMs: 120, maxLongTaskDurationMs: 100, droppedFrames: 113, frameIntervals: 755, droppedFramePercent: 13.02},
    {longTasksOver50Ms: 5, blockingTimeMs: 166, maxLongTaskDurationMs: 135, droppedFrames: 136, frameIntervals: 805, droppedFramePercent: 14.45}
  ]}});
  const result = evaluatePerformance(report({base, head}), scrollHistory(19));
  const row = formatPerformanceTable(result).split('\n').find((line) => line.includes('Scroll back 2,000 messages (100x)'));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k')), false);
  assert.match(row, /report only.*19\/20/);
});

test('reports scroll misses when base history measurements are unavailable', () => {
  const base = scaleVariants();
  base['100x'].scrollBack2k = Array.from({length: 3}, () => ({bundleBytes: 100_000}));
  const head = scaleVariants({'100x': {scrollBack2k: {longTasksOver50Ms: 1}}});
  const result = evaluatePerformance(report({base, head}));
  const row = formatPerformanceTable(result).split('\n').find((line) => line.includes('Scroll back 2,000 messages (100x)'));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k')), false);
  assert.match(row, /report only.*0\/20/);
});

test('blocks calibrated scroll regressions against the master noise band', () => {
  const base = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 10, blockingTimeMs: 300, maxLongTaskDurationMs: 100, droppedFrames: 202, frameIntervals: 865, droppedFramePercent: 18.93},
    {longTasksOver50Ms: 10, blockingTimeMs: 300, maxLongTaskDurationMs: 100, droppedFrames: 2, frameIntervals: 701, droppedFramePercent: 0.28},
    {longTasksOver50Ms: 10, blockingTimeMs: 300, maxLongTaskDurationMs: 100, droppedFrames: 2, frameIntervals: 755, droppedFramePercent: 0.26}
  ]}});
  const head = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 1, blockingTimeMs: 100, droppedFrames: 2, frameIntervals: 98, droppedFramePercent: 2},
    {longTasksOver50Ms: 1, blockingTimeMs: 100, droppedFrames: 6, frameIntervals: 94, droppedFramePercent: 6},
    {longTasksOver50Ms: 1, blockingTimeMs: 100, droppedFrames: 6, frameIntervals: 94, droppedFramePercent: 6}
  ]}});
  const result = evaluatePerformance(report({base, head}), scrollHistory());
  const table = formatPerformanceTable(result);
  const row = table.split('\n').find((line) => line.includes('Scroll back 2,000 messages (100x)'));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('long task')));
  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('blocking time')));
  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('dropped frames')));
  assert.match(table, /Scroll noise band/);
  assert.match(row, /tasks 0\.0–0\.0; blocking 0\.0–0\.0 ms; frames 0\.00–0\.00%/);
});

test('allows one noisy head scroll repeat against the calibrated master band', () => {
  const base = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0, droppedFrames: 53, frameIntervals: 872, droppedFramePercent: 6.08},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0, droppedFrames: 11, frameIntervals: 967, droppedFramePercent: 1.14},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0, droppedFrames: 15, frameIntervals: 787, droppedFramePercent: 1.91}
  ]}});
  const head = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 0, blockingTimeMs: 0, droppedFrames: 0, frameIntervals: 100, droppedFramePercent: 0},
    {longTasksOver50Ms: 23, blockingTimeMs: 582, droppedFrames: 225, frameIntervals: 942, droppedFramePercent: 23.89},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, droppedFrames: 0, frameIntervals: 100, droppedFramePercent: 0}
  ]}});
  const result = evaluatePerformance(report({base, head}), scrollHistory());

  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k')), false);
});

test('blocks repeated dropped frames above the calibrated master band', () => {
  const base = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 10, blockingTimeMs: 300, droppedFrames: 202, frameIntervals: 865, droppedFramePercent: 18.93},
    {longTasksOver50Ms: 10, blockingTimeMs: 300, droppedFrames: 2, frameIntervals: 701, droppedFramePercent: 0.28},
    {longTasksOver50Ms: 10, blockingTimeMs: 300, droppedFrames: 2, frameIntervals: 755, droppedFramePercent: 0.26}
  ]}});
  const head = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 0, blockingTimeMs: 0, droppedFrames: 6, frameIntervals: 94, droppedFramePercent: 6},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, droppedFrames: 6, frameIntervals: 94, droppedFramePercent: 6},
    {longTasksOver50Ms: 0, blockingTimeMs: 0, droppedFrames: 6, frameIntervals: 94, droppedFramePercent: 6}
  ]}});
  const result = evaluatePerformance(report({base, head}), scrollHistory());

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('dropped frames')));
});

test('blocks repeated dropped-frame regressions above a stable nonzero master baseline', () => {
  const masterSamples = Array.from({length: 3}, () => ({
    longTasksOver50Ms: 0,
    blockingTimeMs: 0,
    maxLongTaskDurationMs: 0,
    droppedFrames: 2,
    frameIntervals: 98,
    droppedFramePercent: 2
  }));
  const head = scaleVariants({'100x': {scrollBack2k: Array.from({length: 3}, () => ({
    longTasksOver50Ms: 0,
    blockingTimeMs: 0,
    droppedFrames: 6,
    frameIntervals: 94,
    droppedFramePercent: 6
  }))}});
  const result = evaluatePerformance(report({head}), scrollHistory(20, masterSamples));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('dropped frames')));
  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('long task')), false);
  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('blocking time')), false);
});

test('allows blocking-time jitter below 80 ms when 100x contacts long-task counts do not grow', () => {
  const base = scaleVariants({'100x': {contactsList: [
    {longTasksOver50Ms: 0, blockingTimeMs: 0, maxLongTaskDurationMs: 0},
    {longTasksOver50Ms: 4, blockingTimeMs: 432, maxLongTaskDurationMs: 158},
    {longTasksOver50Ms: 1, blockingTimeMs: 99, maxLongTaskDurationMs: 149}
  ]}});
  const head = scaleVariants({'100x': {contactsList: [
    {longTasksOver50Ms: 1, blockingTimeMs: 112, maxLongTaskDurationMs: 162},
    {longTasksOver50Ms: 1, blockingTimeMs: 100, maxLongTaskDurationMs: 150},
    {longTasksOver50Ms: 1, blockingTimeMs: 117, maxLongTaskDurationMs: 167}
  ]}});
  const result = evaluatePerformance(report({base, head}));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('100x contactsList') && failure.includes('blocking time')), false);
});

test('fails closed when head blocking-time instrumentation is missing', () => {
  const head = scaleVariants();
  delete head['100x'].chatOpen[0].blockingTimeMs;
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x chatOpen') && failure.includes('long-task blocking time')));
});

test('fails closed when the measured 100x base omits blocking time', () => {
  const base = scaleVariants();
  delete base['100x'].chatOpen[0].blockingTimeMs;
  const result = evaluatePerformance(report({base}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x chatOpen') && failure.includes('base long-task blocking time')));
});

test('blocks a 100 ms cold-load stall when noisy repeats overlap', () => {
  const base = scaleVariants({'100x': {coldChatList: [
    {longTasksOver50Ms: 2, blockingTimeMs: 175},
    {longTasksOver50Ms: 2, blockingTimeMs: 184},
    {longTasksOver50Ms: 2, blockingTimeMs: 230}
  ]}});
  const head = scaleVariants({'100x': {coldChatList: [
    {longTasksOver50Ms: 2, blockingTimeMs: 225},
    {longTasksOver50Ms: 2, blockingTimeMs: 228},
    {longTasksOver50Ms: 2, blockingTimeMs: 181}
  ]}});
  const result = evaluatePerformance(report({base, head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x coldChatList') && failure.includes('blocking time')));
});

test('blocks an 80 ms increase in blocking time when a 100x task count matches base', () => {
  const base = scaleVariants({'100x': {coldChatList: [
    {longTasksOver50Ms: 2, blockingTimeMs: 100},
    {longTasksOver50Ms: 2, blockingTimeMs: 100},
    {longTasksOver50Ms: 2, blockingTimeMs: 100}
  ]}});
  const head = scaleVariants({'100x': {coldChatList: [
    {longTasksOver50Ms: 2, blockingTimeMs: 179},
    {longTasksOver50Ms: 2, blockingTimeMs: 180},
    {longTasksOver50Ms: 2, blockingTimeMs: 181}
  ]}});
  const result = evaluatePerformance(report({base, head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x coldChatList') && failure.includes('blocking time')));
});

test('blocks a non-scroll long task when the base has no measured count', () => {
  const base = scaleVariants();
  base['100x'].dateJump = Array.from({length: 3}, () => ({bundleBytes: 100_000}));
  const head = scaleVariants({'100x': {dateJump: {longTasksOver50Ms: 1}}});
  const result = evaluatePerformance(report({base, head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x dateJump') && failure.includes('long task')));
});

test('blocks added 100x blocking time against compatible main history when there is no base', () => {
  const head = scaleVariants({'100x': {globalSearch: [
    {longTasksOver50Ms: 1, blockingTimeMs: 180},
    {longTasksOver50Ms: 1, blockingTimeMs: 180},
    {longTasksOver50Ms: 1, blockingTimeMs: 180}
  ]}});
  const history = mainHistory(1, {'100x': {globalSearch: {longTasksOver50Ms: 1, blockingTimeMs: 100}}});
  const result = evaluatePerformance(report({head, requireBase: false}), history);

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x globalSearch') && failure.includes('blocking time')));
});

test('compares 100x long tasks with compatible main history when a push has no base', () => {
  const head = scaleVariants({'100x': {globalSearch: [
    {longTasksOver50Ms: 2},
    {longTasksOver50Ms: 2},
    {longTasksOver50Ms: 2}
  ]}});
  const result = evaluatePerformance(report({head, requireBase: false}), mainHistory(1, {
    '100x': {globalSearch: {longTasksOver50Ms: 1}}
  }));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x globalSearch') && failure.includes('long task')));
});

test('does not block for a long task measured only at 1x', () => {
  const head = scaleVariants({'1x': {chatOpen: {longTasksOver50Ms: 1}}});
  const result = evaluatePerformance(report({head}));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('1x chatOpen') && failure.includes('long task')), false);
});

test('reports fixed 100x timing budget misses before calibration', () => {
  const overBudget = Object.fromEntries(SCENARIOS.filter(({budgetMs}) => budgetMs !== null).map((scenario) => [scenario.key, {ms: scenario.budgetMs + 1}]));
  const head = scaleVariants({'100x': overBudget});
  const result = evaluatePerformance(report({head}), mainHistory(19));
  const table = formatPerformanceTable(result);

  assert.equal(result.calibratedScenarios, 0);
  assert.match(table, /Blocking time \(ms\)/);
  for(const scenario of SCENARIOS.filter(({budgetMs}) => budgetMs !== null)) {
    assert.equal(result.blockingFailures.some((failure) => failure.includes(`100x ${scenario.key}`) && failure.includes(`${scenario.budgetMs} ms budget`)), false);
    assert.equal(result.rows.find((row) => row.scale === '100x' && row.key === scenario.key).budgetStatus, 'warming');
    const row = table.split('\n').find((line) => line.includes(`${scenario.label} (100x)`));
    assert.match(row, /over budget \(report only\)/);
  }
});

test('defers relative timing comparisons until calibration', () => {
  const head = scaleVariants({'100x': {dateJump: {ms: 121}}});
  const result = evaluatePerformance(report({head}), mainHistory(19));
  const row = result.rows.find((item) => item.scale === '100x' && item.key === 'dateJump');

  assert.equal(result.blockingFailures.some((failure) => failure.includes('dateJump') && failure.includes('regressed beyond')), false);
  assert.equal(row.budgetStatus, 'warming');
});

test('marks timing budgets as report-only while historical comparisons warm up', () => {
  const head = scaleVariants({'100x': {coldChatList: {ms: 900}}});
  const result = evaluatePerformance(report({head}), mainHistory(19));
  const table = formatPerformanceTable(result);
  const coldRow = table.split('\n').find((line) => line.includes('Cold interactive chat list (100x)'));
  const dateJumpRow = table.split('\n').find((line) => line.includes('Jump to a date (100x)'));

  assert.match(coldRow, /report only/);
  assert.match(dateJumpRow, /report only/);
});

test('blocks fixed 100x timing budgets once that scenario is calibrated', () => {
  const head = scaleVariants({'100x': {coldChatList: {ms: 1_200}}});
  const result = evaluatePerformance(report({head}), mainHistory());

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x') && failure.includes('coldChatList') && failure.includes('1000 ms budget')));
  assert.equal(result.rows.find((row) => row.scale === '100x' && row.key === 'coldChatList').budgetStatus, 'failed');
});

test('reports request and DOM changes without blocking the gate', () => {
  const head = scaleVariants({'100x': {globalSearch: {requests: 13, domNodes: 301}}});
  const result = evaluatePerformance(report({head}));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('globalSearch') && /requests|DOM nodes/.test(failure)), false);
  const row = result.rows.find((item) => item.scale === '100x' && item.key === 'globalSearch');
  assert.equal(row.base.requests, 12);
  assert.equal(row.head.requests, 13);
  assert.equal(row.base.domNodes, 300);
  assert.equal(row.head.domNodes, 301);
});

test('blocks an incomplete head measurement instead of treating missing counters as zero', () => {
  const head = scaleVariants();
  head['100x'].chatOpen = [head['100x'].chatOpen[0]];
  delete head['100x'].chatOpen[0].requests;
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x') && failure.includes('chatOpen') && failure.includes('requests')));
  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x') && failure.includes('chatOpen') && failure.includes('repeat')));
});

test('requires three head and base measurements for every scale scenario', () => {
  const head = scaleVariants();
  head['100x'].chatOpen = head['100x'].chatOpen.slice(0, 2);
  const base = scaleVariants();
  base['1x'].chatOpen = base['1x'].chatOpen.slice(0, 2);
  const result = evaluatePerformance(report({head, base}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x') && failure.includes('chatOpen') && failure.includes('expected at least 3')));
  assert.ok(result.blockingFailures.some((failure) => failure.includes('1x') && failure.includes('chatOpen') && failure.includes('base bundle baseline requires 3')));
});

test('blocks bundle growth above two percent against a complete same-run base', () => {
  const head = scaleVariants({'100x': {coldChatList: {bundleBytes: 102_001}}});
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x') && failure.includes('bundle') && failure.includes('coldChatList')));
});

test('fails closed when a required base bundle measurement is unavailable', () => {
  const result = evaluatePerformance(report({base: {'1x': {}, '100x': {}}}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('base') && failure.includes('bundle') && failure.includes('100x') && failure.includes('coldChatList')));
});

test('compares the median head time with the calibrated main median', () => {
  const head = scaleVariants({'100x': {dateJump: [{ms: 121}, {ms: 114}]}});
  const result = evaluatePerformance(report({head}), mainHistory());

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x') && failure.includes('dateJump') && failure.includes('regressed beyond')));
});

test('applies a two millisecond minimum relative timing threshold', () => {
  const history = mainHistory(20, {'100x': {dateJump: {ms: 10}}});
  const withinFloor = scaleVariants({'100x': {dateJump: {ms: 11.9}}});
  const aboveFloor = scaleVariants({'100x': {dateJump: {ms: 12}}});

  assert.equal(evaluatePerformance(report({head: withinFloor}), history).blockingFailures.some((failure) => failure.includes('dateJump') && failure.includes('regressed beyond')), false);
  assert.ok(evaluatePerformance(report({head: aboveFloor}), history).blockingFailures.some((failure) => failure.includes('dateJump') && failure.includes('regressed beyond')));
});

test('ignores calibration runs from a different fixture or server runtime', () => {
  const incompatibleHistory = [
    ...mainHistory(),
    ...mainHistory(20, {'100x': {dateJump: {ms: 1}}}, {...CURRENT_FIXTURE, fixtureVersion: 'fixture-old'}),
    ...mainHistory(20, {'100x': {dateJump: {ms: 1}}}, {...CURRENT_FIXTURE, serverCommit: 'runtime-old'}),
    ...mainHistory(20, {'100x': {dateJump: {ms: 1}}}, {...CURRENT_FIXTURE, fixtureServerCommit: 'seed-old'}),
    ...mainHistory(20, {'100x': {dateJump: {ms: 1}}}, {...CURRENT_FIXTURE, measurementVersion: 1})
  ];
  const result = evaluatePerformance(report(), incompatibleHistory);
  const row = result.rows.find((item) => item.scale === '100x' && item.key === 'dateJump');

  assert.equal(row.historyRuns, 20);
  assert.deepEqual(row.noiseBand, [85, 115]);
});

test('blocks a calibrated 100x scenario above the 1.5x slowdown ceiling', () => {
  const head = scaleVariants({
    '1x': {coldChatList: {ms: 100}},
    '100x': {coldChatList: {ms: 151}}
  });
  const result = evaluatePerformance(report({head}), mainHistory());

  assert.ok(result.blockingFailures.some((failure) => failure.includes('coldChatList') && failure.includes('1.5x') && failure.includes('151')));
});

test('allows a calibrated scenario at the 1.5x slowdown ceiling', () => {
  const head = scaleVariants({
    '1x': {coldChatList: {ms: 100}},
    '100x': {coldChatList: {ms: 150}}
  });
  const result = evaluatePerformance(report({head}), mainHistory());

  assert.equal(result.blockingFailures.some((failure) => failure.includes('coldChatList') && failure.includes('1.5x')), false);
});

test('keeps the 1.5x scale ceiling report-only until both scales are calibrated', () => {
  const head = scaleVariants({
    '1x': {coldChatList: {ms: 100}},
    '100x': {coldChatList: {ms: 200}}
  });
  const result = evaluatePerformance(report({head}), mainHistory(19));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('coldChatList') && failure.includes('1.5x')), false);
});
