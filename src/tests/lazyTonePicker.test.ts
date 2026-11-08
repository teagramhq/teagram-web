import {describe, expect, test, vi} from 'vitest';
import showLazyTonePicker from '@components/emoticonsDropdown/lazyTonePicker';

describe('lazy tone picker', () => {
  const menu = document.createElement('div');

  test('shows and cleans up in order once the picker has loaded', async() => {
    const calls: string[] = [];
    const picker = {show: vi.fn(() => calls.push('show')), cleanup: vi.fn(() => calls.push('cleanup'))};
    let resolve: (value: typeof picker) => void;
    const lazy = showLazyTonePicker(() => new Promise((r) => resolve = r), vi.fn());

    lazy.show(menu);
    lazy.cleanup();
    expect(calls).toEqual([]);

    resolve(picker);
    await vi.waitFor(() => expect(calls).toEqual(['show', 'cleanup']));
    expect(picker.show).toHaveBeenCalledWith(menu);
  });

  test('reports a failed load once and leaves show and cleanup as no-ops', async() => {
    const onError = vi.fn();
    const failure = new Error('chunk failed');
    const lazy = showLazyTonePicker(() => Promise.reject(failure), onError);

    lazy.show(menu);
    lazy.cleanup();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith(failure);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
