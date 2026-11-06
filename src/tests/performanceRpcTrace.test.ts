import {describe, expect, test} from 'vitest';
import {collectCachedDialogReconcileSummaries, collectCachedDialogReconciles, findLongTasksWithSignificantSpanWork, findLongTasksOverlappingWalkMirrors, mergeCachedDialogReconcilePhaseSnapshots, observeLongAnimationFrames, selectHistoryPathTasks, settleInterruptedCachedDialogReconciles, summarizeCachedDialogReconcile, summarizeCpuProfile, summarizeLongTaskAttribution, summarizeLongTaskTrace, summarizePerformancePhases, summarizeReconcileMirrorTasks, summarizeRpcTrace, validateCachedDialogReconcileSummaries, validateNoWalkLongTasks, type PerformanceTaskAttribution} from '../../e2e/performanceRpcTrace';
import {PerformancePhaseTrace} from '../lib/appManagers/performanceTrace';

const mirror = (startTimeMs: number, durationMs: number) => ({traceId: 'walk', startTimeMs, durationMs});

test('attributes a long task to the walk only when a walk mirror task overlaps it', () => {
  const tasks = [{startTimeMs: 100, durationMs: 80}, {startTimeMs: 400, durationMs: 54}, {startTimeMs: 600, durationMs: 50}];

  expect(findLongTasksOverlappingWalkMirrors(tasks, [mirror(150, 3)])).toEqual([tasks[0]]);
  expect(findLongTasksOverlappingWalkMirrors(tasks, [mirror(10, 90), mirror(180, 5), mirror(395, 10)])).toEqual([tasks[1]]);
  expect(findLongTasksOverlappingWalkMirrors(tasks, [mirror(610, 5)])).toEqual([]);
  expect(findLongTasksOverlappingWalkMirrors(tasks, [])).toEqual([]);
  expect(findLongTasksOverlappingWalkMirrors(undefined, undefined)).toEqual([]);
});

test('does not attribute a task to a mirror ending exactly at its rounded start', () => {
  const task = {startTimeMs: 59.8, durationMs: 52};
  expect(findLongTasksOverlappingWalkMirrors([task], [mirror(59.7, 0.1)])).toEqual([]);
  expect(findLongTasksOverlappingWalkMirrors([task], [mirror(59.71, 0.1)])).toEqual([task]);
});

test('uses precise timestamps to distinguish overlaps hidden by display rounding', () => {
  const task = {startTimeMs: 59.8, durationMs: 52, preciseStartTimeMs: 59.805, preciseDurationMs: 52};
  const adjacent = {...mirror(59.7, 0.1), preciseStartTimeMs: 59.699, preciseDurationMs: 0.105};
  const overlapping = {...adjacent, preciseDurationMs: 0.11};
  expect(findLongTasksOverlappingWalkMirrors([task], [adjacent])).toEqual([]);
  expect(findLongTasksOverlappingWalkMirrors([task], [overlapping])).toEqual([task]);
  const justOverThreshold = {...task, durationMs: 50, preciseDurationMs: 50.004};
  expect(findLongTasksOverlappingWalkMirrors([justOverThreshold], [overlapping])).toEqual([justOverThreshold]);
  const capturedTask = summarizeLongTaskTrace([{startTime: 159.805, duration: 52}], [], 100, 100);
  const capturedMirror = summarizeReconcileMirrorTasks([{traceId: 'walk', startedAtMs: 159.699, durationMs: 0.11}], 100, 100);
  expect(findLongTasksOverlappingWalkMirrors(capturedTask, capturedMirror)).toHaveLength(1);
  expect(() => validateNoWalkLongTasks([{longTaskTrace: capturedTask, reconcileMirrorTasks: capturedMirror}], 'scroll')).toThrow('scroll repeat 1 has 1 tasks');
});

test('keeps only the walk mirror tasks that start inside the window, relative to it', () => {
  const result = summarizeReconcileMirrorTasks([
    {traceId: 'walk', startedAtMs: 900, durationMs: 4},
    {traceId: 'walk', startedAtMs: 1_250.123, durationMs: 2.456},
    {traceId: 'walk', startedAtMs: 2_100, durationMs: 1}
  ], 1_000, 1_000);
  expect(result).toMatchObject([{traceId: 'walk', startTimeMs: 250.12, durationMs: 2.46, preciseDurationMs: 2.456}]);
  expect(result[0].preciseStartTimeMs).toBeCloseTo(250.123, 8);
});

test('rejects a diagnostic repeat whose long task overlaps a walk mirror task', () => {
  const overlapping = {longTaskTrace: [{startTimeMs: 100, durationMs: 70}], reconcileMirrorTasks: [mirror(120, 2)]};
  expect(() => validateNoWalkLongTasks([overlapping], '100x chatOpen diagnostic'))
  .toThrow('100x chatOpen diagnostic repeat 1 has 1 tasks over 50 ms overlapping a walk mirror task');
  expect(() => validateNoWalkLongTasks([{}, {longTaskTrace: [{startTimeMs: 100, durationMs: 70}], reconcileMirrorTasks: []}], 'x')).not.toThrow();
});

test('reports when the newest walk page was requested relative to the scenario', () => {
  const phase = {traceId: 'walk', pageCount: 0, startedAtEpochMs: 1_000, durationMs: 5_000, lastPageRequestedAtEpochMs: 1_050};
  expect(collectCachedDialogReconciles([phase], 3_000, 4_000, {walk: 0}).walks[0].lastPageRequestOffsetMs).toBe(-1_950);
});

test('summarizes cached dialog reconciliation relative to a scenario', () => {
  expect(summarizeCachedDialogReconcile({
    traceId: 'reconcile-1',
    pageCount: 30,
    startedAtEpochMs: 1_000,
    durationMs: 2_500
  }, 2_000, 640)).toEqual({
    traceId: 'reconcile-1',
    pageCount: 30,
    startRelativeToScenarioMs: -1_000,
    endRelativeToScenarioMs: 1_500,
    mainThreadTimeMs: 640
  });
});

test('associates only walks that overlap each measured scenario and records no-walk windows', () => {
  const laterWalk = {
    traceId: 'later-walk',
    pageCount: 4,
    startedAtEpochMs: 17_700,
    durationMs: 500
  };
  const mainThreadTimeByTraceId = {'later-walk': 12.5};

  expect(collectCachedDialogReconciles([laterWalk], 0, 1_450, mainThreadTimeByTraceId)).toEqual({walks: []});
  expect(collectCachedDialogReconciles([laterWalk], 17_500, 18_000, mainThreadTimeByTraceId)).toEqual({
    walks: [{
      traceId: 'later-walk',
      pageCount: 4,
      startRelativeToScenarioMs: 200,
      endRelativeToScenarioMs: 700,
      mainThreadTimeMs: 12.5
    }]
  });
  expect(() => collectCachedDialogReconciles([laterWalk], 17_500, 18_000, {})).toThrow('main-thread time');
});

test('reports only page completions inside each scenario window', () => {
  const phase = {
    traceId: 'walk', pageCount: 4, startedAtEpochMs: 1_000, durationMs: 5_000,
    pageCompletedAtEpochMs: [1_200, 2_000, 2_500, 4_000]
  };
  const summary = collectCachedDialogReconciles([phase], 2_000, 3_000, {walk: 1});
  expect(summary.walks[0].pageCompletionOffsetsMs).toEqual([0, 500]);
  const outside = collectCachedDialogReconciles([phase], 4_100, 5_000, {walk: 1});
  expect(outside.walks[0].pageCompletionOffsetsMs).toEqual([]);
});

test('attributes a long warm-list walk to every overlapping scroll repeat', () => {
  expect(collectCachedDialogReconcileSummaries([
    {scenarioStartedAtEpochMs: 0, scenarioEndedAtEpochMs: 1_000},
    {scenarioStartedAtEpochMs: 10_000, scenarioEndedAtEpochMs: 20_000},
    {scenarioStartedAtEpochMs: 30_000, scenarioEndedAtEpochMs: 40_000},
    {scenarioStartedAtEpochMs: 50_000, scenarioEndedAtEpochMs: 62_000},
    {scenarioStartedAtEpochMs: 70_000, scenarioEndedAtEpochMs: 80_000}
  ], [{
    traceId: 'warm-list-walk',
    pageCount: 50,
    startedAtEpochMs: 500,
    durationMs: 60_000
  }], {'warm-list-walk': 18.6})).toEqual([
    {walks: [{traceId: 'warm-list-walk', pageCount: 50, startRelativeToScenarioMs: 500, endRelativeToScenarioMs: 60_500, mainThreadTimeMs: 18.6}]},
    {walks: [{traceId: 'warm-list-walk', pageCount: 50, startRelativeToScenarioMs: -9_500, endRelativeToScenarioMs: 50_500, mainThreadTimeMs: 18.6}]},
    {walks: [{traceId: 'warm-list-walk', pageCount: 50, startRelativeToScenarioMs: -29_500, endRelativeToScenarioMs: 30_500, mainThreadTimeMs: 18.6}]},
    {walks: [{traceId: 'warm-list-walk', pageCount: 50, startRelativeToScenarioMs: -49_500, endRelativeToScenarioMs: 10_500, mainThreadTimeMs: 18.6}]},
    {walks: []}
  ]);
});

test('keeps a completed async reconciliation phase over a stale pending snapshot', () => {
  const completed = {
    traceId: 'long-walk',
    pageCount: 50,
    startedAtEpochMs: 1_000,
    durationMs: 60_000
  };
  expect(mergeCachedDialogReconcilePhaseSnapshots([
    [{...completed, durationMs: null, pageCount: undefined}],
    [completed]
  ])).toEqual([completed]);
});

test('keeps the furthest pending snapshot of a walk', () => {
  const pending = {traceId: 'long-walk', startedAtEpochMs: 1_000, durationMs: null as number | null};
  expect(mergeCachedDialogReconcilePhaseSnapshots([
    [{...pending, pageCount: 3}],
    [{...pending, pageCount: 17}],
    [{...pending, pageCount: 9}]
  ])).toEqual([{...pending, pageCount: 17}]);
});

test('ends a walk its worker no longer reports at the next page start', () => {
  const dead = {traceId: 'dead-walk', pageCount: 17, startedAtEpochMs: 1_000, durationMs: null as number | null};
  const live = {traceId: 'live-walk', startedAtEpochMs: 4_000, durationMs: null as number | null};
  const finished = {traceId: 'done-walk', pageCount: 50, startedAtEpochMs: 500, durationMs: 700};

  expect(settleInterruptedCachedDialogReconciles([dead, live, finished], ['live-walk'], [0, 3_000, 9_000])).toEqual([
    {...dead, durationMs: 2_000, interrupted: true},
    live,
    finished
  ]);
  expect(settleInterruptedCachedDialogReconciles([dead], [], [0])).toEqual([dead]);
});

test('summarizes an interrupted walk without a main-thread flush', () => {
  const interrupted = {traceId: 'dead-walk', pageCount: 17, startedAtEpochMs: 1_000, durationMs: 2_000, interrupted: true};
  expect(collectCachedDialogReconciles([interrupted], 0, 5_000, {})).toEqual({
    walks: [{
      traceId: 'dead-walk',
      pageCount: 17,
      startRelativeToScenarioMs: 1_000,
      endRelativeToScenarioMs: 3_000,
      mainThreadTimeMs: 0,
      interrupted: true
    }]
  });
  expect(() => collectCachedDialogReconciles([{...interrupted, interrupted: undefined}], 0, 5_000, {})).toThrow('main-thread time');
});

test('requires a page count for interrupted reconciliation walks', () => {
  const summary = {walks: [{
    traceId: 'dead-walk',
    pageCount: null as number | null,
    startRelativeToScenarioMs: -1_000,
    endRelativeToScenarioMs: 14_000,
    mainThreadTimeMs: 0,
    interrupted: true
  }]};

  expect(() => validateCachedDialogReconcileSummaries([
    {cachedDialogReconcile: summary}
  ], 'scrollBack2k', 1)).toThrow('100x scrollBack2k measured repeat 1 has incomplete reconciliation data');
});

test('requires a complete reconciliation summary on every measured scenario repeat', () => {
  const summary = {
    walks: [{
      traceId: 'reconcile-1',
      pageCount: 30,
      startRelativeToScenarioMs: -100,
      endRelativeToScenarioMs: 2_500,
      mainThreadTimeMs: 640
    }]
  };

  expect(() => validateCachedDialogReconcileSummaries([
    {cachedDialogReconcile: summary},
    {cachedDialogReconcile: {walks: []}}
  ], 'scrollBack2k', 2)).not.toThrow();
  expect(() => validateCachedDialogReconcileSummaries([
    {cachedDialogReconcile: summary},
    {}
  ], 'scrollBack2k', 2)).toThrow('100x scrollBack2k measured repeat 2 has incomplete reconciliation data');
});

test('keeps completed reconciliation measurements when the scenario trace resets', async() => {
  const trace = new PerformancePhaseTrace(true);
  const startedAtEpochMs = performance.timeOrigin + performance.now() - 10;
  const finish = trace.start('worker.dialogs.cachedChannelReconcile', {startedAtEpochMs, traceId: 'reconcile-test'});
  trace.start('worker.storage.load')();

  const helpers = await import('../../e2e/performanceRpcTrace') as unknown as {
    getScenarioPreservedPerformancePhases?: unknown
  };
  expect(helpers.getScenarioPreservedPerformancePhases).toBeTypeOf('function');
  const getPreservedPhases = helpers.getScenarioPreservedPerformancePhases as () => string[];
  trace.reset(getPreservedPhases());
  finish({pageCount: 30});

  const phase = {...trace.getSnapshot()[0], traceId: 'reconcile-test'};
  expect(summarizeCachedDialogReconcile(phase, startedAtEpochMs - 25, 12.5)).toEqual({
    traceId: 'reconcile-test',
    pageCount: 30,
    startRelativeToScenarioMs: 25,
    endRelativeToScenarioMs: Number((25 + phase.durationMs!).toFixed(2)),
    mainThreadTimeMs: 12.5
  });
});

test('validates each independent diagnostic repeat with a reconcile summary and task trace', async() => {
  const validate = (await import('../../e2e/performanceRpcTrace') as any).validateCachedDialogReconcileDiagnostics;
  expect(validate).toBeTypeOf('function');
  const summary = {
    walks: [{
      traceId: 'reconcile-1',
      pageCount: 30,
      startRelativeToScenarioMs: -100,
      endRelativeToScenarioMs: 2_500,
      mainThreadTimeMs: 640
    }]
  };

  expect(() => validate([
    {cachedDialogReconcile: summary, longTaskTrace: []},
    {cachedDialogReconcile: {walks: [{...summary.walks[0], startRelativeToScenarioMs: -80}]}, longTaskTrace: [{startTimeMs: 10}]}
  ], 'contactSearch', 2)).not.toThrow();
});

test('requires the expected number of independent diagnostic repeats', async() => {
  const validate = (await import('../../e2e/performanceRpcTrace') as any).validateCachedDialogReconcileDiagnostics;
  expect(validate).toBeTypeOf('function');
  expect(() => validate([], 'contactSearch', 2)).toThrow('100x contactSearch has 0 diagnostic repeats; expected 2');
});

test('rejects independent diagnostic repeats with incomplete reconciliation evidence', async() => {
  const validate = (await import('../../e2e/performanceRpcTrace') as any).validateCachedDialogReconcileDiagnostics;
  expect(validate).toBeTypeOf('function');
  expect(() => validate([
    {cachedDialogReconcile: {walks: [{traceId: 'reconcile-1', pageCount: 30, startRelativeToScenarioMs: -100, endRelativeToScenarioMs: null, mainThreadTimeMs: 640}]}, longTaskTrace: []}
  ], 'contactSearch', 1)).toThrow('100x contactSearch diagnostic repeat 1 has incomplete reconciliation or long-task data');
});

test('requires a completed cached-dialog walk for each required warm-flow diagnostic repeat', async() => {
  const validate = (await import('../../e2e/performanceRpcTrace') as any).validateCachedDialogReconcileDiagnostics;
  expect(validate).toBeTypeOf('function');
  const completedWalk = {
    traceId: 'reconcile-1',
    pageCount: 30,
    startRelativeToScenarioMs: -100,
    endRelativeToScenarioMs: 2_500,
    mainThreadTimeMs: 640
  };
  expect(() => validate([
    {cachedDialogReconcile: {walks: [completedWalk]}, longTaskTrace: []}
  ], 'dateJump', 1, true)).not.toThrow();
  expect(() => validate([
    {cachedDialogReconcile: {walks: []}, longTaskTrace: []}
  ], 'dateJump', 1, true)).toThrow('100x dateJump diagnostic repeat 1 has no completed cached-dialog walk');
  expect(() => validate([
    {cachedDialogReconcile: {walks: [{...completedWalk, interrupted: true}]}, longTaskTrace: []}
  ], 'dateJump', 1, true)).toThrow('100x dateJump diagnostic repeat 1 has no completed cached-dialog walk');
});

test('records missing and partial measured attribution without failing', async() => {
  const {classifyMeasuredLongTaskTrace} = await import('../../e2e/performanceRpcTrace');
  const task = {
    startTimeMs: 10,
    durationMs: 80,
    scripts: [{functionName: 'onMessage', script: '/app.js', invoker: 'MessagePort.onmessage', invokerType: 'event-listener', durationMs: 70, forcedStyleAndLayoutDurationMs: 0}]
  };

  expect(classifyMeasuredLongTaskTrace({longTasksOver50Ms: 1, longTaskTrace: [task]})).toBe('complete');
  expect(classifyMeasuredLongTaskTrace({longTasksOver50Ms: 0, longTaskTrace: []})).toBe('complete');
  expect(classifyMeasuredLongTaskTrace({longTasksOver50Ms: 1})).toBe('missing');
  expect(classifyMeasuredLongTaskTrace({longTasksOver50Ms: 1, longTaskTrace: [{...task, scripts: []}]})).toBe('partial');
  expect(classifyMeasuredLongTaskTrace({longTasksOver50Ms: 2, longTaskTrace: [task]})).toBe('partial');
});

test('returns history-path task attribution for the performance artifact', () => {
  const historyTask: PerformanceTaskAttribution = {
    startTimeMs: 100,
    durationMs: 70,
    spans: [{name: 'bubbles.prepareToSaveScroll', startOffsetMs: 5, syncMs: 15}],
    stacks: []
  };
  const reconcileTask: PerformanceTaskAttribution = {
    startTimeMs: 120,
    durationMs: 80,
    spans: [{name: 'dialogs.cachedChannelReconcile', startOffsetMs: 2, syncMs: 25}],
    stacks: []
  };

  expect(selectHistoryPathTasks([historyTask, reconcileTask], ['bubbles.prepareToSaveScroll'])).toEqual([historyTask]);
});

describe('performance RPC trace summary', () => {
  test('counts RPC invocations in the elapsed window relative to its start', async() => {
    const trace = await import('../../e2e/performanceRpcTrace') as any;
    const result = trace.rpcInvocationsInWindow([
      {method: 'before', startedAtEpochMs: 1099},
      {method: 'first', startedAtEpochMs: 1100},
      {method: 'last', startedAtEpochMs: 1199},
      {method: 'after', startedAtEpochMs: 1201}
    ], 1000, 100, 100);
    expect(result.map((call: {method: string}) => call.method)).toEqual(['first', 'last']);
  });

  test('reports method counts for every invocation inside the measurement window', async() => {
    const trace = await import('../../e2e/performanceRpcTrace') as any;
    expect(trace.rpcMethodCounts([
      {method: 'messages.getHistory', startedAtEpochMs: 1100},
      {method: 'messages.getHistory', startedAtEpochMs: 1110},
      {method: 'messages.search', startedAtEpochMs: 1120},
      {method: 'messages.search', startedAtEpochMs: 1201}
    ], 1000, 100, 100)).toEqual({'messages.getHistory': 2, 'messages.search': 1});
  });
  test('excludes long tasks that start outside the scenario measurement window', async() => {
    const trace = await import('../../e2e/performanceRpcTrace') as any;
    const summary = trace.summarizeLongTaskWindow?.([
      {startTime: 99, duration: 80},
      {startTime: 100, duration: 60},
      {startTime: 200, duration: 50},
      {startTime: 349, duration: 75},
      {startTime: 350, duration: 90},
      {startTime: 420, duration: 150}
    ], 100, 250);

    expect(summary).toEqual({
      longTasksOver50Ms: 2,
      blockingTimeMs: 35,
      maxLongTaskDurationMs: 75
    });
  });

  test('attributes measured long tasks to overlapping long-animation-frame scripts without URL queries', () => {
    const trace = summarizeLongTaskTrace([
      {startTime: 110, duration: 80},
      {startTime: 190, duration: 51},
      {startTime: 300, duration: 100}
    ], [
      {
        startTime: 105,
        duration: 100,
        scripts: [{
          sourceURL: 'https://localhost:4176/assets/app.js?token=private',
          sourceFunctionName: 'renderMessages',
          invoker: 'EventListener.handleEvent',
          invokerType: 'event-listener',
          executionStart: 125,
          duration: 55,
          forcedStyleAndLayoutDuration: 12
        }]
      },
      {
        startTime: 180,
        duration: 80,
        scripts: [{
          sourceURL: 'https://localhost:4176/assets/scroll.js',
          sourceFunctionName: 'onScroll',
          invoker: 'Window.requestAnimationFrame',
          invokerType: 'user-callback',
          executionStart: 185,
          duration: 60,
          forcedStyleAndLayoutDuration: 20
        }]
      }
    ], 100, 200);

    expect(trace).toEqual([
      {
        startTimeMs: 10,
        durationMs: 80,
        scripts: [
          {
            functionName: 'renderMessages',
            script: '/assets/app.js',
            invoker: 'EventListener.handleEvent',
            invokerType: 'event-listener',
            durationMs: 55,
            forcedStyleAndLayoutDurationMs: 12
          },
          {
            functionName: 'onScroll',
            script: '/assets/scroll.js',
            invoker: 'Window.requestAnimationFrame',
            invokerType: 'user-callback',
            durationMs: 60,
            forcedStyleAndLayoutDurationMs: 20
          }
        ]
      },
      {
        startTimeMs: 90,
        durationMs: 51,
        scripts: [{
          functionName: 'onScroll',
          script: '/assets/scroll.js',
          invoker: 'Window.requestAnimationFrame',
          invokerType: 'user-callback',
          durationMs: 60,
          forcedStyleAndLayoutDurationMs: 20
        }]
      }
    ]);
    expect(JSON.stringify(trace)).not.toContain('private');
  });

  test('counts RPC calls and subtracts overlapping waits only once', () => {
    const summary = summarizeRpcTrace([
      {method: 'messages.getDialogs', startedAtMs: 0, durationMs: 30, outcome: 'success'},
      {method: 'messages.getHistory', startedAtMs: 10, durationMs: 20, outcome: 'success'},
      {method: 'help.getConfig', startedAtMs: 40, durationMs: null, outcome: 'pending'}
    ], 60);

    expect(summary.rpcCallCount).toBe(3);
    expect(summary.rpcWallMs).toBe(50);
    expect(summary.nonRpcElapsedMs).toBe(10);
    expect(summary.rpcCalls.map(({method}) => method)).toEqual([
      'messages.getDialogs',
      'messages.getHistory',
      'help.getConfig'
    ]);
    expect(summary.rpcCalls[2].durationMs).toBeNull();
  });

  test('summarizes sampled client CPU by function without retaining trace arguments', () => {
    const summary = summarizeCpuProfile({
      nodes: [
        {id: 1, callFrame: {functionName: '(root)', url: ''}, children: [2]},
        {id: 2, callFrame: {functionName: 'performHistoryResult', url: 'http://localhost:4176/assets/app.js?token=private'}, children: [3]},
        {id: 3, callFrame: {functionName: 'deleteViewportSlice', url: 'http://localhost:4176/assets/app.js'}, children: [4]},
        {id: 4, callFrame: {functionName: 'remove', url: ''}}
      ],
      samples: [2, 4, 4],
      timeDeltas: [1_000, 2_000, 3_000]
    });

    expect(summary.sampledCpuMs).toBe(6);
    expect(summary.topFrames).toEqual([
      {functionName: 'remove', script: '/native', selfMs: 5},
      {functionName: 'performHistoryResult', script: '/assets/app.js', selfMs: 1}
    ]);
    expect(summary.topStacks).toEqual([
      {
        frames: [
          {functionName: 'performHistoryResult', script: '/assets/app.js'},
          {functionName: 'deleteViewportSlice', script: '/assets/app.js'},
          {functionName: 'remove', script: '/native'}
        ],
        selfMs: 5
      },
      {
        frames: [{functionName: 'performHistoryResult', script: '/assets/app.js'}],
        selfMs: 1
      }
    ]);
    expect(JSON.stringify(summary)).not.toContain('private');
  });

  test('summarizes worker and peer-change phases without retaining trace details', () => {
    const summary = summarizePerformancePhases([
      {name: 'worker.storage.load', durationMs: 38.125, accountNumber: 1},
      {name: 'chat.finishPeerChange.input', durationMs: 91.4},
      {name: 'chat.finishPeerChange.bubbles', durationMs: 22.2, peerId: 12345}
    ]);

    expect(summary).toEqual([
      {name: 'worker.storage.load', durationMs: 38.13, accountNumber: 1},
      {name: 'chat.finishPeerChange.input', durationMs: 91.4},
      {name: 'chat.finishPeerChange.bubbles', durationMs: 22.2}
    ]);
    expect(JSON.stringify(summary)).not.toContain('peerId');
  });
});

describe('long task attribution', () => {
  const profile = {
    nodes: [
      {id: 1, callFrame: {functionName: '(root)'}, children: [2, 3]},
      {id: 2, callFrame: {functionName: 'mountUnmountGroups', url: 'https://x.test/assets/chat.js?t=1'}},
      {id: 3, callFrame: {functionName: 'onMirrorTask', url: 'https://x.test/assets/proxy.js'}}
    ],
    // samples end at 1010, 1030, 1070 and 1120 ms on the page clock when the profile starts at 1000
    samples: [3, 2, 2, 3],
    timeDeltas: [10_000, 20_000, 40_000, 50_000]
  };

  test('attributes CPU samples to a dropped-frame interval shorter than a long task', () => {
    const result = summarizeLongTaskAttribution(
      [{startTime: 1020, duration: 30}], [], profile, 1000, 1000, 1000, 0
    );
    expect(result).toEqual([{
      startTimeMs: 20,
      durationMs: 30,
      spans: [],
      stacks: [{frames: [{functionName: 'mountUnmountGroups', script: '/assets/chat.js'}], selfMs: 30}]
    }]);
  });

  test('joins spans and CPU samples to the long task they ran in', () => {
    const result = summarizeLongTaskAttribution(
      [{startTime: 1020, duration: 60}, {startTime: 1500, duration: 10}],
      [
        {name: 'bubbles.mountUnmountGroups', startMs: 1040, syncMs: 25.123},
        {name: 'bubbles.performHistoryResult', startMs: 900, syncMs: 5}
      ],
      profile,
      1000,
      1000,
      1000
    );

    expect(result).toEqual([{
      startTimeMs: 20,
      durationMs: 60,
      spans: [{name: 'bubbles.mountUnmountGroups', startOffsetMs: 20, syncMs: 25.12}],
      stacks: [
        {frames: [{functionName: 'mountUnmountGroups', script: '/assets/chat.js'}], selfMs: 50},
        {frames: [{functionName: 'onMirrorTask', script: '/assets/proxy.js'}], selfMs: 10}
      ]
    }]);
  });

  test('excludes diagnostic long tasks that start after the scenario window', async() => {
    const summarizeWithinWindow = (await import('../../e2e/performanceRpcTrace') as any).summarizeLongTaskAttribution;

    expect(summarizeWithinWindow([
      {startTime: 1020, duration: 60},
      {startTime: 1150, duration: 80}
    ], [], {nodes: [], samples: [], timeDeltas: []}, 1000, 1000, 100)).toEqual([{
      startTimeMs: 20,
      durationMs: 60,
      spans: [],
      stacks: []
    }]);
  });

  test('flags a long task when history scroll span work exceeds 50 ms', () => {
    const scrollWork: PerformanceTaskAttribution = {
      startTimeMs: 20,
      durationMs: 130,
      spans: [{name: 'bubbles.processBatch', startOffsetMs: 2, syncMs: 60}],
      stacks: []
    };

    expect(findLongTasksWithSignificantSpanWork([scrollWork], ['bubbles.processBatch'])).toEqual([scrollWork]);
  });

  test('flags a long task dominated by history scroll work below 50 ms', () => {
    const dominatedWork: PerformanceTaskAttribution = {
      startTimeMs: 20,
      durationMs: 61,
      spans: [{name: 'bubbles.processBatch', startOffsetMs: 2, syncMs: 45}],
      stacks: []
    };

    expect(findLongTasksWithSignificantSpanWork([dominatedWork], ['bubbles.processBatch'])).toEqual([dominatedWork]);
  });

  test('counts disjoint history scroll spans toward the task work', () => {
    const disjointWork: PerformanceTaskAttribution = {
      startTimeMs: 20,
      durationMs: 100,
      spans: [
        {name: 'bubbles.processBatch', startOffsetMs: 0, syncMs: 30},
        {name: 'scrollSaver.save', startOffsetMs: 40, syncMs: 30}
      ],
      stacks: []
    };

    expect(findLongTasksWithSignificantSpanWork([disjointWork], ['bubbles.processBatch', 'scrollSaver.save'])).toEqual([disjointWork]);
  });

  test('throws when a selected scroll span has a non-finite start offset', () => {
    const invalidWork: PerformanceTaskAttribution = {
      startTimeMs: 20,
      durationMs: 61,
      spans: [{name: 'bubbles.processBatch', startOffsetMs: Number.NaN, syncMs: 45}],
      stacks: []
    };

    expect(() => findLongTasksWithSignificantSpanWork([invalidWork], ['bubbles.processBatch'])).toThrow(/finite/);
  });

  test('throws when a selected scroll span has non-finite work', () => {
    const invalidWork: PerformanceTaskAttribution = {
      startTimeMs: 20,
      durationMs: 61,
      spans: [{name: 'bubbles.processBatch', startOffsetMs: 2, syncMs: Number.NaN}],
      stacks: []
    };

    expect(() => findLongTasksWithSignificantSpanWork([invalidWork], ['bubbles.processBatch'])).toThrow(/finite/);
  });

  test('ignores a long task that only overlaps a short history scroll span', () => {
    const overlappingWork: PerformanceTaskAttribution = {
      startTimeMs: 20,
      durationMs: 61,
      spans: [{name: 'bubbles.processBatch', startOffsetMs: 2, syncMs: 17}],
      stacks: []
    };

    expect(findLongTasksWithSignificantSpanWork([overlappingWork], ['bubbles.processBatch'])).toEqual([]);
  });

  test('does not count nested history scroll spans more than once', () => {
    const nestedWork: PerformanceTaskAttribution = {
      startTimeMs: 20,
      durationMs: 61,
      spans: [
        {name: 'bubbles.processBatch', startOffsetMs: 0, syncMs: 20},
        {name: 'scrollSaver.save', startOffsetMs: 5, syncMs: 20},
        {name: 'scrollSaver.restore', startOffsetMs: 10, syncMs: 15}
      ],
      stacks: []
    };

    expect(findLongTasksWithSignificantSpanWork([nestedWork], ['bubbles.processBatch', 'scrollSaver.save', 'scrollSaver.restore'])).toEqual([]);
  });
});

describe('long-animation-frame observation', () => {
  function makeObserver(supportedEntryTypes: string[] | undefined) {
    const observed: unknown[] = [];
    class FakeObserver {
      static supportedEntryTypes = supportedEntryTypes;
      constructor(public callback: (list: {getEntries(): unknown[]}) => void) {}
      observe(options: unknown) {
        observed.push(options);
      }
    }
    return {FakeObserver, observed};
  }

  test('reports an unsupported entry type without throwing or observing', () => {
    const {FakeObserver, observed} = makeObserver(['longtask', 'paint']);

    expect(observeLongAnimationFrames(FakeObserver, () => {})).toBe(false);
    expect(observed).toEqual([]);
  });

  test('reports a browser without supportedEntryTypes as unsupported', () => {
    const {FakeObserver} = makeObserver(undefined);

    expect(observeLongAnimationFrames(FakeObserver, () => {})).toBe(false);
  });

  test('observes buffered entries when the type is supported', () => {
    const {FakeObserver, observed} = makeObserver(['longtask', 'long-animation-frame']);

    expect(observeLongAnimationFrames(FakeObserver, () => {})).toBe(true);
    expect(observed).toEqual([{type: 'long-animation-frame', buffered: true}]);
  });

  test('returns the observer handle so the capture window can disconnect it', () => {
    const {FakeObserver} = makeObserver(['long-animation-frame']);
    let capturedObserver: unknown;

    expect(observeLongAnimationFrames(FakeObserver, () => {}, (observer) => capturedObserver = observer)).toBe(true);
    expect(capturedObserver).toBeInstanceOf(FakeObserver);
  });

  test('is false when observing throws', () => {
    class ThrowingObserver {
      static supportedEntryTypes = ['long-animation-frame'];
      observe() {
        throw new Error('unsupported');
      }
    }

    expect(observeLongAnimationFrames(ThrowingObserver, () => {})).toBe(false);
  });

  test('stays self-contained so its source can be injected into the page', () => {
    const injected = new Function(`return ${observeLongAnimationFrames.toString()}`)() as typeof observeLongAnimationFrames;
    const {FakeObserver} = makeObserver(['long-animation-frame']);

    expect(injected(FakeObserver, () => {})).toBe(true);
    expect(injected({supportedEntryTypes: []}, () => {})).toBe(false);
  });
});
