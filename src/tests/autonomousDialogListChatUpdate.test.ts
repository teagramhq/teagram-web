import {expect, test} from 'vitest';
import {shouldReconcileEmptyChannelDialog} from '@lib/rootScope';

test('skips only duplicate empty-channel dialog reconciliation when requested', () => {
  expect(shouldReconcileEmptyChannelDialog({skipEmptyChannelDialogReconciliation: true})).toBe(false);
  expect(shouldReconcileEmptyChannelDialog()).toBe(true);
});
