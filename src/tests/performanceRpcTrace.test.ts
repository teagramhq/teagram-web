import {expect, test} from 'vitest';
import {summarizeCachedDialogReconcile} from '../../e2e/performanceRpcTrace';

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
