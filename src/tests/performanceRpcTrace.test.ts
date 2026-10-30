import {describe, expect, test} from 'vitest';
import {summarizeCpuProfile, summarizePerformancePhases, summarizeRpcTrace} from '../../e2e/performanceRpcTrace';

describe('performance RPC trace summary', () => {
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
