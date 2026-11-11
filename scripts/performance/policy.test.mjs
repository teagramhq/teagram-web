import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLD_CHAT_LIST_REPEATS,
  evaluatePairedDifferences,
  evaluatePerformance,
  formatPerformanceTable,
  formatPerformanceTraceTable,
  pairedMedianLowerConfidenceBound,
  PERFORMANCE_MEASUREMENT_VERSION,
  PERFORMANCE_REPEATS,
  SCENARIOS,
  scenarioBundleBytes
} from './policy.mjs';

const SCALES = ['1x', '100x'];
const CURRENT_FIXTURE = {
  measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
  fixtureVersion: 'fixture-v1',
  serverCommit: 'runtime-server-v1',
  fixtureServerCommit: 'fixture-server-v1'
};

function sample(overrides = {}) {
  return {
    ms: 100,
    requests: 12,
    rpcCallCount: 0,
    domNodes: 300,
    bundleBytes: 100_000,
    longTasksOver50Ms: 0,
    blockingTimeMs: 0,
    maxLongTaskDurationMs: 0,
    frameIntervals: 100,
    droppedFrames: 0,
    droppedFramePercent: 0,
    rafDropped: 0,
    ...overrides
  };
}

function scaleSamples(overrides = {}) {
  return Object.fromEntries(SCENARIOS.map(({key}) => {
    const override = overrides[key];
    const values = Array.isArray(override) ? override : Array.from({length: PERFORMANCE_REPEATS}, () => override || {});
    return [key, values.map((entry) => sample(entry))];
  }));
}

function scaleVariants(overrides = {}) {
  return {
    '1x': scaleSamples(overrides['1x']),
    '100x': scaleSamples(overrides['100x'])
  };
}

function walkDiagnostics() {
  const emptySamples = () => Array.from({length: PERFORMANCE_REPEATS}, () => ({walkLongTasksOver50Ms: 0}));
  return {
    '100x': {
      walkComparison: {
        base: Object.fromEntries(SCENARIOS.map(({key}) => [key, emptySamples()])),
        head: Object.fromEntries(SCENARIOS.map(({key}) => [key, emptySamples()]))
      }
    }
  };
}

function report({base = scaleVariants(), head = scaleVariants(), requireBase = true, ...metadata} = {}) {
  return {
    ...CURRENT_FIXTURE,
    diagnostics: walkDiagnostics(),
    ...metadata,
    requireBase,
    variants: {base, head}
  };
}

function mainHistory(count = 20, overrides = {}, metadata = CURRENT_FIXTURE) {
  const head = scaleVariants(overrides);
  return Array.from({length: count}, () => ({...metadata, variants: {head}}));
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function normalSample(random) {
  const first = Math.max(Number.EPSILON, random());
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * random());
}

function timingReport(baseTimes, headTimes, metadata = {}) {
  const base = scaleVariants();
  const head = scaleVariants();
  base['1x'].chatOpen = baseTimes.map((ms) => sample({ms}));
  head['1x'].chatOpen = headTimes.map((ms) => sample({ms}));
  return report({base, head, ...metadata});
}

test('uses the second-smallest paired difference as the one-sided 95% median lower bound', () => {
  assert.equal(PERFORMANCE_REPEATS, 9);
  assert.equal(COLD_CHAT_LIST_REPEATS, PERFORMANCE_REPEATS);
  assert.equal(pairedMedianLowerConfidenceBound([-5, -1, 0, 1, 2, 3, 4, 5, 150]), -1);
  assert.equal(pairedMedianLowerConfidenceBound(Array(8).fill(1)), undefined);
});

test('A/A timing samples with one 150 ms runner stall pass in at least 99 of 100 fixed-seed trials', () => {
  const random = seededRandom(3610);
  let passes = 0;

  for(let trial = 0; trial < 100; ++trial) {
    const base = Array.from({length: PERFORMANCE_REPEATS}, () => 500 + normalSample(random) * 10);
    const head = Array.from({length: PERFORMANCE_REPEATS}, () => 500 + normalSample(random) * 10);
    head[trial % PERFORMANCE_REPEATS] += 150;
    const result = evaluatePerformance(timingReport(base, head));
    if(!result.blockingFailures.some((failure) => failure.startsWith('1x chatOpen:'))) ++passes;
  }

  assert.ok(passes >= 99, `only ${passes}/100 A/A trials passed`);
});

test('A/A 100x budget and scale gates tolerate noise above their absolute limits', () => {
  const random = seededRandom(3612);
  let passes = 0;

  const samplesAround = (center, deviation) => Array.from({length: PERFORMANCE_REPEATS}, () => sample({ms: center + normalSample(random) * deviation}));
  for(let trial = 0; trial < 100; ++trial) {
    const base = scaleVariants();
    const head = scaleVariants();
    for(const variant of [base, head]) {
      variant['1x'].chatOpen = samplesAround(148, 2);
      variant['100x'].chatOpen = samplesAround(310.5, 10);
      variant['1x'].contactsList = samplesAround(100, 1.5);
      variant['100x'].contactsList = samplesAround(302, 5);
    }

    const stalledScenario = trial % 2 ? 'chatOpen' : 'contactsList';
    head['100x'][stalledScenario][trial % PERFORMANCE_REPEATS].ms += 150;
    const failures = evaluatePerformance(report({base, head})).blockingFailures;
    const targetedFailures = failures.filter((failure) => {
      return failure.includes('100x chatOpen: absolute timing budget') ||
        failure.startsWith('100x/1x chatOpen:') ||
        failure.startsWith('100x/1x contactsList:');
    });
    if(!targetedFailures.length) ++passes;
  }

  assert.ok(passes >= 99, `only ${passes}/100 A/A trials passed`);
});

test('scenario budget values come only from the timing minimum-effects table', () => {
  assert.ok(SCENARIOS.every((scenario) => !Object.hasOwn(scenario, 'budgetMs')));
});

test('detects the 95%-power shift at the measured final-head spread in at least 95 of 100 fixed-seed trials', () => {
  const random = seededRandom(3611);
  let detections = 0;
  const baseMedian = 151.9;
  const pairedSpread = 16.60828578437991;
  const minimumEffect = baseMedian * 0.15;
  const shiftFor95Power = minimumEffect + 1.7389 * pairedSpread;

  for(let trial = 0; trial < 100; ++trial) {
    const differences = Array.from({length: PERFORMANCE_REPEATS}, () => shiftFor95Power + normalSample(random) * pairedSpread);
    if(evaluatePairedDifferences(differences, minimumEffect).regression) ++detections;
  }

  assert.ok(detections >= 95, `only ${detections}/100 shifted trials were detected`);
});

test('blocks only when the paired lower bound clears the relative minimum effect', () => {
  const baseTimes = Array(PERFORMANCE_REPEATS).fill(200);
  const justBelow = Array(PERFORMANCE_REPEATS).fill(229);
  const justAbove = Array(PERFORMANCE_REPEATS).fill(231);

  assert.equal(evaluatePerformance(timingReport(baseTimes, justBelow)).blockingFailures.some((failure) => failure.startsWith('1x chatOpen:')), false);
  assert.ok(evaluatePerformance(timingReport(baseTimes, justAbove)).blockingFailures.some((failure) => failure.startsWith('1x chatOpen:')));
});

test('requires exactly nine complete base and head samples for every PR timing scenario', () => {
  const base = scaleVariants();
  const head = scaleVariants();
  base['100x'].dateJump = base['100x'].dateJump.slice(0, 8);
  head['100x'].dateJump = head['100x'].dateJump.slice(0, 8);
  const result = evaluatePerformance(report({base, head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x dateJump: base expected exactly 9 samples, got 8')));
  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x dateJump: head expected exactly 9 samples, got 8')));
});

test('master history adds calibration rows but cannot affect timing pass or fail', () => {
  const head = scaleVariants({'100x': {dateJump: {ms: 180}}});
  const reportWithoutBase = report({head, requireBase: false});
  const quietHistory = mainHistory(20, {'100x': {dateJump: {ms: 180}}});
  const noisyHistory = mainHistory(20, {'100x': {dateJump: {ms: 1}}});
  const quiet = evaluatePerformance(reportWithoutBase, quietHistory);
  const noisy = evaluatePerformance(reportWithoutBase, noisyHistory);

  assert.deepEqual(quiet.blockingFailures, []);
  assert.deepEqual(noisy.blockingFailures, []);
  assert.deepEqual(noisy.reportOnlyFailures, []);
  assert.equal(noisy.rows.find((row) => row.scale === '100x' && row.key === 'dateJump').historyRuns, 20);
  assert.match(formatPerformanceTable(noisy), /calibration/);
});

test('master runs still block on incomplete deterministic head and diagnostic samples', () => {
  const head = scaleVariants();
  head['100x'].dateJump = head['100x'].dateJump.slice(0, PERFORMANCE_REPEATS - 1);
  const missingHead = evaluatePerformance(report({head, requireBase: false}));
  assert.ok(missingHead.blockingFailures.some((failure) => failure.includes('100x dateJump: head expected exactly 9 samples, got 8')));

  const diagnostics = walkDiagnostics();
  diagnostics['100x'].walkComparison.head.dateJump = diagnostics['100x'].walkComparison.head.dateJump.slice(0, PERFORMANCE_REPEATS - 1);
  const missingTrace = evaluatePerformance(report({requireBase: false, diagnostics}));
  assert.ok(missingTrace.blockingFailures.some((failure) => failure.includes('100x dateJump: head walk-mirror diagnostic expected exactly 9 samples, got 8')));
});

test('legacy scroll history without RAF counts does not hide other scenario history', () => {
  const history = mainHistory(20, {'100x': {scrollBack2k: {droppedFramePercent: 10}}});
  history.forEach((run) => run.variants.head['100x'].scrollBack2k.forEach((sample) => {
    delete sample.rafDropped;
  }));
  const result = evaluatePerformance(report({requireBase: false}), history);
  const scroll = result.rows.find((row) => row.scale === '100x' && row.key === 'scrollBack2k');
  const chatOpen = result.rows.find((row) => row.scale === '100x' && row.key === 'chatOpen');

  assert.equal(scroll.historyRuns, 0);
  assert.equal(scroll.scrollHistoryRuns, 0);
  assert.equal(chatOpen.historyRuns, 20);
});

test('requires a valid RAF drop count for every 100x scroll sample', () => {
  const base = scaleVariants();
  const head = scaleVariants();
  delete base['100x'].scrollBack2k[0].rafDropped;
  delete head['100x'].scrollBack2k[1].rafDropped;
  const result = evaluatePerformance(report({base, head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k: base RAF drop count is missing or invalid in sample 1')));
  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k: head RAF drop count is missing or invalid in sample 2')));

  const invalidSamples = [
    {
      sample: {rafDropped: -1},
      failure: '100x scrollBack2k: head RAF drop count is invalid in sample 1'
    },
    {
      sample: {rafDropped: 1.5},
      failure: '100x scrollBack2k: head RAF drop count is invalid in sample 1'
    },
    {
      sample: {rafDropped: 1, droppedFrames: 0},
      failure: '100x scrollBack2k: head RAF drop count is invalid in sample 1'
    }
  ];
  for(const {sample: invalidSample, failure} of invalidSamples) {
    const invalidHead = scaleVariants();
    Object.assign(invalidHead['100x'].scrollBack2k[0], invalidSample);
    const invalidResult = evaluatePerformance(report({head: invalidHead}));
    assert.ok(invalidResult.blockingFailures.some((message) => message.includes(failure)), failure);
  }
});

test('paired absolute budget headroom fails only when the lower bound crosses the budget', () => {
  const base = scaleVariants({'100x': {coldChatList: {ms: 900}}});
  const atBudget = scaleVariants({'100x': {coldChatList: {ms: 1_000}}});
  const overBudget = scaleVariants({'100x': {coldChatList: {ms: 1_036}}});

  assert.equal(evaluatePerformance(report({base, head: atBudget})).blockingFailures.some((failure) => failure.includes('1000 ms budget')), false);
  assert.ok(evaluatePerformance(report({base, head: overBudget})).blockingFailures.some((failure) => failure.includes('1000 ms budget')));
});

test('absolute budget gate keeps the relative minimum when base is already over budget', () => {
  const base = scaleVariants({'100x': {chatOpen: {ms: 310.5}}});
  const withinRelativeMinimum = scaleVariants({'100x': {chatOpen: {ms: 340.5}}});
  const beyondRelativeMinimum = scaleVariants({'100x': {chatOpen: {ms: 360}}});
  const withinResult = evaluatePerformance(report({base, head: withinRelativeMinimum}));
  const beyondResult = evaluatePerformance(report({base, head: beyondRelativeMinimum}));

  assert.equal(withinResult.blockingFailures.some((failure) => failure.includes('absolute timing budget')), false);
  assert.ok(beyondResult.blockingFailures.some((failure) => failure.includes('absolute timing budget') && failure.includes('46.57 ms')));
});

test('long-task, blocking-time, and dropped-frame scroll gates compare paired repeats', () => {
  const base = scaleVariants({'100x': {scrollBack2k: {
    longTasksOver50Ms: 1,
    blockingTimeMs: 100,
    droppedFramePercent: 10
  }}});
  const oneExtraTask = scaleVariants({'100x': {scrollBack2k: {
    longTasksOver50Ms: 2,
    blockingTimeMs: 100,
    droppedFramePercent: 10
  }}});
  const extraBlocking = scaleVariants({'100x': {scrollBack2k: {
    longTasksOver50Ms: 1,
    blockingTimeMs: 126,
    droppedFramePercent: 10
  }}});
  const extraDrops = scaleVariants({'100x': {scrollBack2k: {
    longTasksOver50Ms: 1,
    blockingTimeMs: 100,
    droppedFramePercent: 11.6
  }}});

  assert.equal(evaluatePerformance(report({base, head: oneExtraTask})).blockingFailures.some((failure) => failure.includes('long-task count')), false);
  assert.ok(evaluatePerformance(report({base, head: extraBlocking})).blockingFailures.some((failure) => failure.includes('long-task blocking time')));
  assert.ok(evaluatePerformance(report({base, head: extraDrops})).blockingFailures.some((failure) => failure.includes('dropped-frame percentage')));
});

test('the 100 ms negative control still fails the blocking-time gate', () => {
  const base = scaleVariants({'100x': {coldChatList: {longTasksOver50Ms: 0, blockingTimeMs: 0}}});
  const injectedStall = scaleVariants({'100x': {coldChatList: {longTasksOver50Ms: 1, blockingTimeMs: 100, maxLongTaskDurationMs: 100}}});
  const result = evaluatePerformance(report({base, head: injectedStall}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x coldChatList') && failure.includes('long-task blocking time')));
});

test('walk-mirror count uses the same paired lower-bound rule and minimum of one', () => {
  const diagnostics = walkDiagnostics();
  diagnostics['100x'].walkComparison.base.scrollBack2k = Array.from({length: PERFORMANCE_REPEATS}, () => ({walkLongTasksOver50Ms: 0}));
  diagnostics['100x'].walkComparison.head.scrollBack2k = Array.from({length: PERFORMANCE_REPEATS}, () => ({walkLongTasksOver50Ms: 1}));
  const oneExtra = evaluatePerformance(report({diagnostics}));
  diagnostics['100x'].walkComparison.head.scrollBack2k = Array.from({length: PERFORMANCE_REPEATS}, () => ({walkLongTasksOver50Ms: 2}));
  const twoExtra = evaluatePerformance(report({diagnostics}));

  assert.equal(oneExtra.blockingFailures.some((failure) => failure.includes('walk-mirror long-task count')), false);
  assert.ok(twoExtra.blockingFailures.some((failure) => failure.includes('walk-mirror long-task count')));
});

test('a missing paired walk-mirror sample fails closed', () => {
  const diagnostics = walkDiagnostics();
  diagnostics['100x'].walkComparison.base.dateJump = [];
  const result = evaluatePerformance(report({diagnostics}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x dateJump') && failure.includes('base walk-mirror diagnostic expected exactly 9 samples')));
});

test('scale slowdown compares paired base and head ratios against the unchanged 1.5x ceiling', () => {
  const base = scaleVariants({'1x': {coldChatList: {ms: 100}}, '100x': {coldChatList: {ms: 120}}});
  const atLimit = scaleVariants({'1x': {coldChatList: {ms: 100}}, '100x': {coldChatList: {ms: 150}}});
  const overLimit = scaleVariants({'1x': {coldChatList: {ms: 100}}, '100x': {coldChatList: {ms: 151}}});

  assert.equal(evaluatePerformance(report({base, head: atLimit})).blockingFailures.some((failure) => failure.includes('1.50x ceiling')), false);
  assert.ok(evaluatePerformance(report({base, head: overLimit})).blockingFailures.some((failure) => failure.includes('1.50x ceiling')));
});

test('scale ratio gate preserves 15 percent tolerance when base is already above the ceiling', () => {
  const base = scaleVariants({'1x': {chatOpen: {ms: 148}}, '100x': {chatOpen: {ms: 310.8}}});
  const withinRelativeMinimum = scaleVariants({'1x': {chatOpen: {ms: 310.8 / 2.3}}, '100x': {chatOpen: {ms: 310.8}}});
  const beyondRelativeMinimum = scaleVariants({'1x': {chatOpen: {ms: 310.8 / 2.5}}, '100x': {chatOpen: {ms: 310.8}}});
  const withinResult = evaluatePerformance(report({base, head: withinRelativeMinimum}));
  const beyondResult = evaluatePerformance(report({base, head: beyondRelativeMinimum}));

  assert.equal(withinResult.blockingFailures.some((failure) => failure.startsWith('100x/1x chatOpen:')), false);
  assert.ok(beyondResult.blockingFailures.some((failure) => failure.startsWith('100x/1x chatOpen:')));
});

test('startup deterministic request, RPC, and bundle checks remain blocking', () => {
  const base = scaleVariants({'1x': {coldChatList: {requests: 12, rpcCallCount: 0, bundleBytes: 100_000}}});
  const head = scaleVariants({'1x': {coldChatList: {requests: 13, rpcCallCount: 1, bundleBytes: 102_001}}});
  const result = evaluatePerformance(report({base, head}));

  for(const field of ['requests', 'rpcCallCount', 'bundle']) {
    assert.ok(result.blockingFailures.some((failure) => failure.includes(`1x coldChatList:`) && failure.includes(field)));
  }
});

test('contacts bundle counts are stable and keep the existing greater-than-two-percent rule', () => {
  const base = scaleVariants({'100x': {contactsList: Array.from({length: PERFORMANCE_REPEATS}, () => ({bundleBytes: 100_000}))}});
  const atLimit = scaleVariants({'100x': {contactsList: Array.from({length: PERFORMANCE_REPEATS}, () => ({bundleBytes: 102_000}))}});
  const overLimit = scaleVariants({'100x': {contactsList: Array.from({length: PERFORMANCE_REPEATS}, () => ({bundleBytes: 102_001}))}});

  assert.equal(evaluatePerformance(report({base, head: atLimit})).blockingFailures.some((failure) => failure.includes('bundle grew')), false);
  assert.ok(evaluatePerformance(report({base, head: overLimit})).blockingFailures.some((failure) => failure.includes('bundle grew')));
});

test('validates scroll frame counters and diagnostic data', () => {
  const head = scaleVariants();
  delete head['100x'].scrollBack2k[2].frameIntervals;
  const result = evaluatePerformance(report({head}));

  assert.ok(result.blockingFailures.some((failure) => failure.includes('100x scrollBack2k') && failure.includes('frame interval count is missing')));
});

test('scenario bundle measurement counts each new same-origin JavaScript or CSS URL once', () => {
  const resources = [
    {name: 'https://app.example/app.js', startTime: 5, decodedBodySize: 100},
    {name: 'https://app.example/chat-list.js', startTime: 11, decodedBodySize: 100},
    {name: 'https://app.example/chat-list.js', startTime: 12, decodedBodySize: 100},
    {name: 'https://cdn.example/vendor.js', startTime: 12, decodedBodySize: 900},
    {name: 'https://app.example/styles.css', startTime: 12, decodedBodySize: 50},
    {name: 'https://app.example/chat.png', startTime: 12, decodedBodySize: 500}
  ];

  assert.equal(scenarioBundleBytes(resources, 'https://app.example', 10, ['https://app.example/app.js']), 150);
});

test('trace table reports cold and warm diagnostics and handles absent data', () => {
  const diagnostics = {
    coldChatList: [{
      mainPhases: [{name: 'main.bootstrapIm.import', startMs: 100, durationMs: 20}],
      cachedDialogReconcile: {walks: [{pageCount: 12, startRelativeToScenarioMs: 5, endRelativeToScenarioMs: 25, mainThreadTimeMs: 4}]}
    }],
    warmChatList: [{workerPhases: [{name: 'worker.managers.create', accountNumber: 2, startMs: 300, durationMs: 40}]}]
  };
  const table = formatPerformanceTraceTable(diagnostics);

  assert.match(table, /### 100x startup trace spans/);
  assert.match(table, /main\.bootstrapIm\.import/);
  assert.match(table, /worker\.managers\.create/);
  assert.match(table, /across 1 cold repeat and 1 warm repeat/);
  assert.match(table, /one opt-in 100x diagnostic pair; this table reports the head details/);
  assert.match(table, /all paired measured samples in `diagnostics\.100x\.walkComparison`/);
  assert.equal(formatPerformanceTraceTable({}), '');
});
