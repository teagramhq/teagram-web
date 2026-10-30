import {afterEach, describe, expect, test, vi} from 'vitest';
import afterInteractiveList from '@lib/appManagers/afterInteractiveList';
import rootScope from '@lib/rootScope';

describe('afterInteractiveList', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('defers work until the list is interactive and runs it once after the paint window', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    afterInteractiveList(callback);

    expect(callback).not.toHaveBeenCalled();

    rootScope.dispatchEventSingle('chat_list_interactive');
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();

    rootScope.dispatchEventSingle('chat_list_interactive');
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledOnce();
  });
});
