import {afterEach, describe, expect, it, vi} from 'vitest';
import {AppNavigationController, NavigationItem} from '@components/appNavigationController';

describe('AppNavigationController backByItem', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not change browser history when an item refuses to close', () => {
    const item: NavigationItem = {
      type: 'popup',
      onPop: vi.fn(() => false)
    };
    const controller = Object.assign(Object.create(AppNavigationController.prototype), {
      navigations: [item],
      manual: false,
      debug: false,
      log: Object.assign(vi.fn(), {warn: vi.fn()}),
      popping: false
    }) as AppNavigationController;
    const pushState = vi.spyOn(history, 'pushState');

    controller.backByItem(item);

    expect(item.onPop).toHaveBeenCalledOnce();
    expect(controller.getNextIndex()).toBe(1);
    expect(pushState).not.toHaveBeenCalled();
  });
});
