import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import createLazyEmojiImages, {BURST_REQUESTS, SLOT_HOLD_MS, WINDOW_MS} from '@helpers/lazyEmojiImages';
import {markLoadedURL} from '@helpers/dom/loadedUrlCache';
import LazyLoadQueue from '@components/lazyLoadQueue';
import type {Middleware} from '@helpers/middleware';

vi.mock('@components/visibilityIntersector', () => ({
  default: class {
    constructor(private callback: (item: {target: Element, visible: boolean}) => void) {}
    observe(target: Element) { queueMicrotask(() => this.callback({target, visible: true})); }
    unobserve() {}
    disconnect() {}
    lock() {}
    unlock() {}
    unlockAndRefresh() {}
    refresh() {}
    isVisible() { return true; }
  }
}));

const middleware = (() => true) as unknown as Middleware;
const emojiUrl = (index: number | string) => `/assets/img/emoji/test-${index}.png`;

describe('lazy emoji images', () => {
  let push: ReturnType<typeof vi.fn>;
  let remove: ReturnType<typeof vi.fn>;
  let queue: Parameters<typeof createLazyEmojiImages>[0];

  beforeEach(() => {
    push = vi.fn();
    remove = vi.fn();
    queue = {push, delete: remove} as unknown as typeof queue;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('gives an already seen image its src and does not queue it', () => {
    const image = document.createElement('img');
    markLoadedURL('/assets/img/emoji/2764.png');

    createLazyEmojiImages(queue, middleware).load(image, '/assets/img/emoji/2764.png');

    expect(push).not.toHaveBeenCalled();
    expect(image.getAttribute('src')).toBe('/assets/img/emoji/2764.png');
  });

  test('queues an unseen image once with the category middleware and no src', () => {
    const image = document.createElement('img');

    createLazyEmojiImages(queue, middleware).load(image, emojiUrl('queued'));

    expect(image.hasAttribute('src')).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].div).toBe(image);
    expect(push.mock.calls[0][0].middleware).toBe(middleware);
  });

  test('sets the src when the queue loads it and resolves once the request is out, not after the decode', async() => {
    const image = document.createElement('img');
    const decode = vi.fn(() => new Promise<void>(() => {}));
    image.decode = decode;
    createLazyEmojiImages(queue, middleware).load(image, emojiUrl('decode'));

    const loading = push.mock.calls[0][0].load();

    expect(image.getAttribute('src')).toBe(emojiUrl('decode'));
    await expect(loading).resolves.toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
  });

  const loadEach = (count: number, lazy: ReturnType<typeof createLazyEmojiImages>) => {
    const settled: boolean[] = Array(count).fill(false);
    Array.from({length: count}, (_, index) => {
      const image = document.createElement('img');
      lazy.load(image, emojiUrl(`burst-${index}`));
      push.mock.calls[push.mock.calls.length - 1][0].load().then(() => settled[index] = true);
    });
    return settled;
  };

  test('requests a burst at once and holds the slot of every load after it', async() => {
    vi.useFakeTimers();
    const settled = loadEach(BURST_REQUESTS + 1, createLazyEmojiImages(queue, middleware));
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toEqual([...Array(BURST_REQUESTS).fill(true), false]);
    await vi.advanceTimersByTimeAsync(SLOT_HOLD_MS - 1);
    expect(settled[BURST_REQUESTS]).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled[BURST_REQUESTS]).toBe(true);
  });

  test('allows a new burst once a whole window has passed without starts', async() => {
    vi.useFakeTimers();
    const lazy = createLazyEmojiImages(queue, middleware);
    loadEach(BURST_REQUESTS + 1, lazy);
    await vi.advanceTimersByTimeAsync(SLOT_HOLD_MS);
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);

    push.mockClear();
    const settled = loadEach(BURST_REQUESTS + 1, lazy);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toEqual([...Array(BURST_REQUESTS).fill(true), false]);
  });

  test('keeps the hold for a burst that starts inside the window of the last one', async() => {
    vi.useFakeTimers();
    const lazy = createLazyEmojiImages(queue, middleware);
    loadEach(BURST_REQUESTS, lazy);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);

    push.mockClear();
    const settled = loadEach(3, lazy);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toEqual([false, false, false]);
  });

  test('bounds the long-run start rate for a page of new emoji every 0.6 s', async() => {
    vi.useFakeTimers();
    const realQueue = new LazyLoadQueue(8, true);
    const lazy = createLazyEmojiImages(realQueue, middleware);
    const images: HTMLImageElement[] = [];
    const duration = 10_000;
    for(let at = 0; at < duration; at += 600) {
      setTimeout(() => {
        for(let i = 0; i < 40; ++i) {
          const image = document.createElement('img');
          images.push(image);
          lazy.load(image, emojiUrl(`cadence-${at}-${i}`));
        }
      }, at);
    }
    await vi.advanceTimersByTimeAsync(duration);

    const started = images.filter((image) => image.hasAttribute('src')).length;
    // at most one window's allowance up front, then 33 a second
    expect(started).toBeLessThanOrEqual(BURST_REQUESTS + Math.ceil(duration / 1000 * 8 * 1000 / SLOT_HOLD_MS) + 16);
    // a reset after every quiet gap would have started all of them
    expect(images.length).toBe(Math.ceil(duration / 600) * 40);
    expect(started).toBeLessThan(images.length * 0.6);
  });

  test('starts no more than the burst, then about eight loads per slot hold, through a real queue', async() => {
    vi.useFakeTimers();
    const realQueue = new LazyLoadQueue(8, true);
    const lazy = createLazyEmojiImages(realQueue, middleware);
    const images = Array.from({length: 200}, (_, index) => {
      const image = document.createElement('img');
      lazy.load(image, emojiUrl(`real-${index}`));
      return image;
    });
    const started = () => images.filter((image) => image.hasAttribute('src')).length;

    await vi.advanceTimersByTimeAsync(100);
    const afterBurst = started();
    expect(afterBurst).toBeGreaterThanOrEqual(BURST_REQUESTS);
    expect(afterBurst).toBeLessThanOrEqual(BURST_REQUESTS + 8);

    await vi.advanceTimersByTimeAsync(10 * SLOT_HOLD_MS);
    // eight slots, each freed every SLOT_HOLD_MS: about 33 loads a second, not the whole backlog
    expect(started() - afterBurst).toBeLessThanOrEqual(8 * 10 + 8);
    expect(started() - afterBurst).toBeGreaterThanOrEqual(8 * 10 - 16);
  });

  test('deletes every replaced image from the queue except the one that stays', () => {
    const parent = document.createElement('span');
    const images = [0, 1, 2].map(() => document.createElement('img'));
    parent.append(...images);
    const lazy = createLazyEmojiImages(queue, middleware);

    lazy.release(parent, images[0]);
    expect(remove.mock.calls.map(([item]) => item.div)).toEqual([images[1], images[2]]);

    remove.mockClear();
    lazy.release(parent);
    expect(remove).toHaveBeenCalledTimes(3);
  });
});
