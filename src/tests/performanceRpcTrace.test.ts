import {describe, expect, test} from 'vitest';
import {findLongTasksWithSignificantSpanWork, observeLongAnimationFrames, summarizeCpuProfile, summarizeLongTaskAttribution, summarizeLongTaskTrace, summarizePerformancePhases, summarizeRpcTrace, type PerformanceTaskAttribution} from '../../e2e/performanceRpcTrace';

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

  test('joins spans and CPU samples to the long task they ran in', () => {
    const result = summarizeLongTaskAttribution(
      [{startTime: 1020, duration: 60}, {startTime: 1500, duration: 10}],
      [
        {name: 'bubbles.mountUnmountGroups', startMs: 1040, syncMs: 25.123},
        {name: 'bubbles.performHistoryResult', startMs: 900, syncMs: 5}
      ],
      profile,
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

test('reports sampled garbage collection even when it is not a top frame', () => {
  const nodes = Array.from({length: 21}, (_, index) => ({id: index + 1, callFrame: {functionName: `frame${index}`}}));
  nodes.push({id: 22, callFrame: {functionName: '(garbage collector)'}});
  const summary = summarizeCpuProfile({nodes, samples: [...nodes.map(({id}) => id), 1], timeDeltas: [...nodes.map(() => 1_000), 1_000]});
  expect(summary.sampledGcMs).toBe(1);
});
