import {expect, test, vi} from 'vitest';
import {scheduleFirstPageCountRefresh} from '@components/autonomousDialogList/scheduleFirstPageCountRefresh';
import shouldReconcileEmptyChannelDialog from '@components/autonomousDialogList/shouldReconcileEmptyChannelDialog';

test('skips only duplicate empty-channel dialog reconciliation when requested', () => {
  expect(shouldReconcileEmptyChannelDialog({skipEmptyChannelDialogReconciliation: true})).toBe(false);
  expect(shouldReconcileEmptyChannelDialog()).toBe(true);
});

test('defers the first-page count refresh past the initial chat interaction window', async() => {
  vi.useFakeTimers();
  try {
    const refresh = vi.fn();

    scheduleFirstPageCountRefresh(refresh);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
