import {beforeEach, describe, expect, test, vi} from 'vitest';
import createLazyEmojiImages, {FIRST_SCREEN_REQUESTS, SLOT_HOLD_MS} from '@helpers/lazyEmojiImages';
import {markLoadedURL} from '@helpers/dom/loadedUrlCache';
import type {Middleware} from '@helpers/middleware';

describe('lazy emoji images', () => {
  const middleware = (() => true) as unknown as Middleware;
  const push = vi.fn();
  const remove = vi.fn();
  const queue = {push, delete: remove} as unknown as Parameters<typeof createLazyEmojiImages>[0];

  beforeEach(() => {
    push.mockClear();
    remove.mockClear();
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

    createLazyEmojiImages(queue, middleware).load(image, '/assets/img/emoji/1f600.png');

    expect(image.hasAttribute('src')).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].div).toBe(image);
    expect(push.mock.calls[0][0].middleware).toBe(middleware);
  });

  test('sets the src when the queue loads it and resolves once the request is out, not after the decode', async() => {
    const image = document.createElement('img');
    const decode = vi.fn(() => new Promise<void>(() => {}));
    image.decode = decode;
    createLazyEmojiImages(queue, middleware).load(image, '/assets/img/emoji/1f600.png');

    const loading = push.mock.calls[0][0].load();

    expect(image.getAttribute('src')).toBe('/assets/img/emoji/1f600.png');
    await expect(loading).resolves.toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
  });

  test('holds the queue slot for every load past the first screen', async() => {
    vi.useFakeTimers();
    try {
      const lazy = createLazyEmojiImages(queue, middleware);
      const images = Array.from({length: FIRST_SCREEN_REQUESTS + 1}, () => document.createElement('img'));
      images.forEach((image, index) => lazy.load(image, `/assets/img/emoji/paced-${index}.png`));

      const settled: boolean[] = [];
      push.mock.calls.forEach(([item], index) => item.load().then(() => settled[index] = true));
      await vi.advanceTimersByTimeAsync(0);

      expect(settled.slice(0, FIRST_SCREEN_REQUESTS).every(Boolean)).toBe(true);
      expect(settled[FIRST_SCREEN_REQUESTS]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(SLOT_HOLD_MS);
      expect(settled[FIRST_SCREEN_REQUESTS]).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
