import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type ObserverCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;

describe('lazy emoji image', () => {
  let callback: ObserverCallback;
  let observed: Element[];
  let unobserved: Element[];
  let options: IntersectionObserverInit;

  beforeEach(() => {
    vi.resetModules();
    observed = [];
    unobserved = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: ObserverCallback, init: IntersectionObserverInit) {
        callback = cb;
        options = init;
      }

      observe(element: Element) {
        observed.push(element);
      }

      unobserve(element: Element) {
        unobserved.push(element);
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const createImage = (src?: string) => {
    const image = document.createElement('img');
    if(src !== undefined) image.dataset.src = src;
    return image;
  };

  it('keeps the src back until the image is near view', async() => {
    const {default: observeLazyEmojiImage} = await import('@helpers/lazyEmojiImage');
    const image = createImage('/assets/img/emoji/1f600.png');

    observeLazyEmojiImage(image);

    expect(observed).toEqual([image]);
    expect(image.hasAttribute('src')).toBe(false);
    expect(options.rootMargin).toBe('100px');

    callback([{target: image, isIntersecting: false}]);
    expect(image.hasAttribute('src')).toBe(false);

    callback([{target: image, isIntersecting: true}]);
    expect(image.getAttribute('src')).toBe('/assets/img/emoji/1f600.png');
    expect(image.dataset.src).toBeUndefined();
    expect(unobserved).toEqual([image]);
  });

  it('loads every image at once only when there is no IntersectionObserver', async() => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const {default: observeLazyEmojiImage} = await import('@helpers/lazyEmojiImage');
    const image = createImage('/assets/img/emoji/2764.png');

    observeLazyEmojiImage(image);

    expect(image.getAttribute('src')).toBe('/assets/img/emoji/2764.png');
  });

  it('ignores an image that already has its src', async() => {
    const {default: observeLazyEmojiImage} = await import('@helpers/lazyEmojiImage');
    const image = createImage();
    image.src = '/assets/img/emoji/1f44d.png';

    observeLazyEmojiImage(image);

    expect(observed).toEqual([]);
    expect(image.getAttribute('src')).toBe('/assets/img/emoji/1f44d.png');
  });

  it('loads an already-seen image straight away', async() => {
    const {loadLazyEmojiImage} = await import('@helpers/lazyEmojiImage');
    const image = createImage('/assets/img/emoji/1f60d.png');

    loadLazyEmojiImage(image);

    expect(image.getAttribute('src')).toBe('/assets/img/emoji/1f60d.png');
    expect(image.dataset.src).toBeUndefined();
  });
});
