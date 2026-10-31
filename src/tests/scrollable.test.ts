import {expect, test, vi} from 'vitest';

vi.mock('@hooks/useHeavyAnimationCheck', () => ({
  default: (): (() => void) => () => undefined
}));
vi.mock('@environment/overlayScrollSupport', () => ({
  IS_OVERLAY_SCROLL_SUPPORTED: () => false
}));

import Scrollable from '../components/scrollable';

test('checks history triggers from geometry read before scroll callbacks', () => {
  vi.useFakeTimers();

  const container = document.createElement('div');
  let callbackRan = false;
  const readsAfterCallback: string[] = [];
  const geometry = {
    scrollTop: 100,
    scrollHeight: 1_000,
    clientHeight: 500,
    offsetHeight: 500
  };
  for(const [property, value] of Object.entries(geometry)) {
    Object.defineProperty(container, property, {
      configurable: true,
      get: () => {
        if(callbackRan) readsAfterCallback.push(property);
        return value;
      }
    });
  }

  const scrollable = new Scrollable(undefined, 'test', 300, undefined, container);
  scrollable.lastScrollPosition = 200;
  const additionalScroll = vi.fn(() => {
    callbackRan = true;
    container.classList.add('scroll-callback-ran');
  });
  const onScrolledTop = vi.fn();
  const onScrolledBottom = vi.fn();
  scrollable.onAdditionalScroll = additionalScroll;
  scrollable.onScrolledTop = onScrolledTop;
  scrollable.onScrolledBottom = onScrolledBottom;

  try {
    scrollable.onScroll();
    vi.advanceTimersToNextFrame();

    expect(additionalScroll).toHaveBeenCalledOnce();
    expect(onScrolledTop).toHaveBeenCalledOnce();
    expect(onScrolledBottom).not.toHaveBeenCalled();
    expect(onScrolledTop.mock.invocationCallOrder[0]).toBeLessThan(additionalScroll.mock.invocationCallOrder[0]);
    expect(readsAfterCallback).toEqual([]);
  } finally {
    scrollable.destroy();
    vi.useRealTimers();
  }
});
