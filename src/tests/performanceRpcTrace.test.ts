import {describe, expect, test} from 'vitest';
import {summarizeCpuProfile, summarizeLongTaskTrace, summarizePerformancePhases, summarizeRpcTrace} from '../../e2e/performanceRpcTrace';

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
        {id: 1, callFrame: {functionName: '(root)', url: ''}},
        {id: 2, callFrame: {functionName: 'hydrateDialogs', url: 'http://localhost:4176/assets/app.js?token=private'}},
        {id: 3, callFrame: {functionName: 'renderBubble', url: 'http://localhost:4176/assets/app.js'}}
      ],
      samples: [2, 3, 2],
      timeDeltas: [1_000, 2_000, 3_000]
    });

    expect(summary.sampledCpuMs).toBe(6);
    expect(summary.topFrames).toEqual([
      {functionName: 'hydrateDialogs', script: '/assets/app.js', selfMs: 4},
      {functionName: 'renderBubble', script: '/assets/app.js', selfMs: 2}
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
