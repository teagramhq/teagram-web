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

test('blocks a 100 ms main-thread task from the first run', () => {
  const head = scaleVariants({
    '1x': {scrollBack2k: {longTasksOver50Ms: 1}},
    '100x': {scrollBack2k: {longTasksOver50Ms: 1}}
  });
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x') && failure.includes('scrollBack2k') && failure.includes('long task')));
  assert.equal(result.blockingFailures.some((failure) => failure.includes('1x scrollBack2k') && failure.includes('long task')), false);
});

test('blocks 100x scroll frame loss at one percent and reports 1x only', () => {
  const head = scaleVariants({
    '1x': {scrollBack2k: {droppedFrames: 50, frameIntervals: 950, droppedFramePercent: 5}},
    '100x': {scrollBack2k: {droppedFrames: 2, frameIntervals: 198, droppedFramePercent: 1}}
  });
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x') && failure.includes('scrollBack2k') && failure.includes('dropped frames')));
  assert.equal(result.blockingFailures.some((failure) => failure.includes('1x scrollBack2k') && failure.includes('dropped frames')), false);
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

test('blocks a long task in any 100x scroll repeat', () => {
  const head = scaleVariants({'100x': {scrollBack2k: [
    {longTasksOver50Ms: 1},
    {longTasksOver50Ms: 0},
    {longTasksOver50Ms: 0}
  ]}});
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('long task')));
});

test('does not apply the scroll long-task gate to other scenarios', () => {
  const head = scaleVariants({'100x': {chatOpen: {longTasksOver50Ms: 2}}});
  const result = evaluatePerformance(report({head}));

  assert.equal(result.blockingFailures.some((failure) => failure.includes('chatOpen') && failure.includes('long task')), false);
});

test('reports fixed 100x timing budget misses before calibration', () => {
  const overBudget = Object.fromEntries(SCENARIOS.filter(({budgetMs}) => budgetMs !== null).map((scenario) => [scenario.key, {ms: scenario.budgetMs + 1}]));
  const head = scaleVariants({'100x': overBudget});
  const result = evaluatePerformance(report({head}), mainHistory(19));
  const table = formatPerformanceTable(result);

  assert.equal(result.calibratedScenarios, 0);
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
