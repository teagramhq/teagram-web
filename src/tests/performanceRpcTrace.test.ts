import {expect, test} from 'vitest';
import {summarizeCachedDialogReconcile, summarizeCpuProfileLongTasks} from '../../e2e/performanceRpcTrace';

test('summarizes cached dialog reconciliation relative to a scenario', () => {
  expect(summarizeCachedDialogReconcile({
    pageCount: 30,
    startedAtEpochMs: 1_000,
    durationMs: 2_500
  }, 2_000, 640)).toEqual({
    pageCount: 30,
    startRelativeToScenarioMs: -1_000,
    endRelativeToScenarioMs: 1_500,
    mainThreadTimeMs: 640
  });
});

test('summarizes sampled CPU stacks inside long tasks', () => {
  expect(summarizeCpuProfileLongTasks({
    nodes: [
      {id: 1, callFrame: {functionName: '(root)'}, children: [2]},
      {id: 2, callFrame: {functionName: 'mountUnmountGroups', url: 'https://client.test/chat.js', lineNumber: 10, columnNumber: 2}, children: [3]},
      {id: 3, callFrame: {functionName: 'restoreScroll', url: 'https://client.test/history.js', lineNumber: 20, columnNumber: 4}}
    ],
    samples: [2, 3, 2, 3],
    timeDeltas: [10_000, 20_000, 10_000, 30_000]
  }, 100, [{startTime: 120, duration: 50}])).toEqual([{
    startTime: 120,
    duration: 50,
    sampledCpuMs: 30,
    topStacks: [
      {frames: ['mountUnmountGroups (chat.js:11:3)', 'restoreScroll (history.js:21:5)'], sampledCpuMs: 20},
      {frames: ['mountUnmountGroups (chat.js:11:3)'], sampledCpuMs: 10}
    ]
  }]);
});
