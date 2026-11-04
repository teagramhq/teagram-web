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
  const scrollSaver = new ScrollSaver(scrollable, '.bubble', false);
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

test('restores prepended history from scroll-size delta without measuring bubble geometry', async() => {
  vi.useFakeTimers();

  const container = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  container.append(bubble);

  let mutated = false;
  let scrollTop = 200;
  const rectReads: string[] = [];
  Object.defineProperties(container, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value) => scrollTop = value
    },
    scrollHeight: {
      configurable: true,
      get: () => mutated ? 1_100 : 1_000
    },
    clientHeight: {configurable: true, value: 500}
  });
  container.getBoundingClientRect = () => {
    rectReads.push('container');
    return {top: 0, bottom: 500, left: 0, right: 400, width: 400, height: 500} as DOMRect;
  };
  bubble.getBoundingClientRect = () => {
    rectReads.push('bubble');
    return {top: 50, bottom: 100, left: 0, right: 400, width: 400, height: 50} as DOMRect;
  };

  const scrollable = new Scrollable(undefined, 'test', 300, undefined, container);
  const scrollSaver = new ScrollSaver(scrollable, '.bubble', true);

  try {
    const savePosition = (scrollSaver as ScrollSaver & {savePosition?: () => void}).savePosition;
    expect(savePosition).toBeTypeOf('function');
    if(!savePosition) return;

    savePosition.call(scrollSaver);
    mutated = true;
    const restoration = scrollSaver.restoreAfterLayout();

    await vi.advanceTimersToNextFrame();
    await vi.advanceTimersToNextFrame();
    await restoration;

    expect(scrollTop).toBe(300);
    expect(rectReads).toEqual([]);
  } finally {
    scrollable.destroy();
    vi.useRealTimers();
  }
});

test('waits for layout before reading the scroll size after a prepend', async() => {
  vi.useFakeTimers();

  const container = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  container.append(bubble);

  let mutated = false;
  let scrollTop = 200;
  let scrollHeightReads = 0;
  Object.defineProperties(container, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => scrollTop = value
    },
    scrollHeight: {
      configurable: true,
      get: () => {
        if(mutated) ++scrollHeightReads;
        return mutated ? 1_100 : 1_000;
      }
    },
    clientHeight: {configurable: true, value: 500}
  });
  container.getBoundingClientRect = () => ({top: 0, bottom: 500, left: 0, right: 400, width: 400, height: 500} as DOMRect);
  bubble.getBoundingClientRect = () => ({top: 50, bottom: 100, left: 0, right: 400, width: 400, height: 50} as DOMRect);

  const scrollable = new Scrollable(undefined, 'test', 300, undefined, container);
  const scrollSaver = new ScrollSaver(scrollable, '.bubble', true);

  try {
    scrollSaver.savePosition();
    mutated = true;
    const restoration = scrollSaver.restoreAfterLayout();

    await vi.advanceTimersToNextFrame();
    expect(scrollHeightReads).toBe(0);

    await vi.advanceTimersToNextFrame();
    await restoration;
    expect(scrollHeightReads).toBe(1);
  } finally {
    scrollable.destroy();
    vi.useRealTimers();
  }
});
