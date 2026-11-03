import {expect, test, vi} from 'vitest';

import Scrollable from '../components/scrollable';
import ScrollSaver from '../helpers/scrollSaver';

test('defers scroll anchor geometry reads until the next frame', async() => {
  vi.useFakeTimers();

  const container = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  container.append(bubble);

  const readsAfterMutation: string[] = [];
  let mutated = false;
  let scrollTop = 100;
  Object.defineProperties(container, {
    scrollTop: {
      configurable: true,
      get: () => {
        if(mutated) readsAfterMutation.push('scrollTop');
        return scrollTop;
      },
      set: (value: number) => scrollTop = value
    },
    scrollHeight: {
      configurable: true,
      get: () => {
        if(mutated) readsAfterMutation.push('scrollHeight');
        return mutated ? 1_100 : 1_000;
      }
    },
    clientHeight: {configurable: true, value: 500}
  });

  const makeRect = (top: number): DOMRect => ({
    x: 0,
    y: top,
    top,
    bottom: top + 50,
    left: 0,
    right: 400,
    width: 400,
    height: 50,
    toJSON: () => ({})
  });
  container.getBoundingClientRect = () => {
    if(mutated) readsAfterMutation.push('container rect');
    return makeRect(0);
  };
  bubble.getBoundingClientRect = () => {
    if(mutated) readsAfterMutation.push('bubble rect');
    return makeRect(mutated ? 150 : 100);
  };

  const scrollable = new Scrollable(undefined, 'test', 300, undefined, container);
  const scrollSaver = new ScrollSaver(scrollable, '.bubble', true);
  scrollSaver.save();

  try {
    mutated = true;
    const restoreAfterLayout = (scrollSaver as ScrollSaver & {
      restoreAfterLayout?: () => Promise<void>
    }).restoreAfterLayout;
    expect(restoreAfterLayout).toBeTypeOf('function');
    if(!restoreAfterLayout) return;

    const restoration = restoreAfterLayout.call(scrollSaver);
    expect(readsAfterMutation).toEqual([]);

    await vi.advanceTimersToNextFrame();
    await restoration;

    expect(readsAfterMutation).toContain('bubble rect');
    expect(scrollable.scrollPosition).toBe(150);
  } finally {
    scrollable.destroy();
    vi.useRealTimers();
  }
});
