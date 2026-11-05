import {describe, expect, test} from 'vitest';
import {collectCachedDialogReconcileSummaries, collectCachedDialogReconciles, mergeCachedDialogReconcilePhaseSnapshots, observeLongAnimationFrames, settleInterruptedCachedDialogReconciles, summarizeCachedDialogReconcile, summarizeCpuProfile, summarizeLongTaskAttribution, summarizeLongTaskTrace, summarizePerformancePhases, summarizeRpcTrace, validateCachedDialogReconcileSummaries} from '../../e2e/performanceRpcTrace';
import {PerformancePhaseTrace} from '../lib/appManagers/performanceTrace';

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

test('requires attributed long-task traces on every measured scroll repeat', async() => {
  const validate = (await import('../../e2e/performanceRpcTrace') as any).validateMeasuredLongTaskTraces;
  expect(validate).toBeTypeOf('function');
  const task = {
    startTimeMs: 10,
    durationMs: 80,
    scripts: [{functionName: 'onMessage', script: '/app.js', invoker: 'MessagePort.onmessage', invokerType: 'event-listener', durationMs: 70, forcedStyleAndLayoutDurationMs: 0}]
  };

  expect(() => validate([
    {longTasksOver50Ms: 1, longTaskTrace: [task]},
    {longTasksOver50Ms: 0, longTaskTrace: []}
  ], 'scrollBack2k', 2)).not.toThrow();
  expect(() => validate([
    {longTasksOver50Ms: 1, longTaskTrace: [task]},
    {longTasksOver50Ms: 1}
  ], 'scrollBack2k', 2)).toThrow('100x scrollBack2k measured repeat 2 has incomplete long-task attribution');
  expect(() => validate([
    {longTasksOver50Ms: 1, longTaskTrace: [{...task, scripts: []}]}
  ], 'scrollBack2k', 1)).toThrow('100x scrollBack2k measured repeat 1 has incomplete long-task attribution');
});

describe('performance RPC trace summary', () => {
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
