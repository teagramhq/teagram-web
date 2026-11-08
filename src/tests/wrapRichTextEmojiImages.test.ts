import {describe, expect, test, vi} from 'vitest';
import {MessageEntity} from '@layer';
import wrapRichText, {LazyEmojiImages} from '@lib/richTextProcessor/wrapRichText';

vi.mock('@lib/apiManagerProxy', () => ({default: {addEventListener: () => {}, getState: () => Promise.resolve({})}}));
vi.mock('@environment/emojiSupport', () => ({default: false}));

vi.hoisted(() => {
  class IntersectionObserverMock {
    public observe() {}
    public unobserve() {}
    public disconnect() {}
    public takeRecords(): IntersectionObserverEntry[] { return []; }
  }

  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: IntersectionObserverMock
  });

  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  Object.defineProperty(globalThis, 'Worker', {configurable: true, writable: true, value: class Worker {}});
  Object.defineProperty(globalThis, 'CSS', {configurable: true, value: {supports: () => true}});
});

const EMOJI = '\u{1F600}';
const URL_PATH = '/assets/img/emoji/1f600.png';

function wrapEmoji(lazyEmojiImages?: LazyEmojiImages) {
  const entities = [{_: 'messageEntityEmoji', offset: 0, length: EMOJI.length, unicode: '1f600'}] as unknown as MessageEntity[];
  return wrapRichText(EMOJI, {entities, lazyEmojiImages}).querySelector('img.emoji') as HTMLImageElement;
}

describe('wrapRichText emoji images', () => {
  test('requests the image straight away by default', () => {
    expect(wrapEmoji().getAttribute('src')).toBe(URL_PATH);
  });

  test('hands the image to the queue without a src when lazy', async() => {
    const queue = {push: vi.fn()};
    const middleware = vi.fn(() => true) as unknown as LazyEmojiImages['middleware'];

    const image = wrapEmoji({queue, middleware});

    expect(image.hasAttribute('src')).toBe(false);
    expect(queue.push).toHaveBeenCalledTimes(1);
    const item = queue.push.mock.calls[0][0];
    expect(item.div).toBe(image);
    expect(item.middleware).toBe(middleware);

    const loaded = item.load();
    expect(image.getAttribute('src')).toBe(URL_PATH);
    image.dispatchEvent(new Event('load'));
    await expect(loaded).resolves.toBeUndefined();
  });

  test('does not leave the queue waiting on an image that fails to load', async() => {
    const queue = {push: vi.fn()};
    const image = wrapEmoji({queue});

    const loaded = queue.push.mock.calls[0][0].load();
    image.dispatchEvent(new Event('error'));

    await expect(loaded).resolves.toBeUndefined();
  });

  test('loads an image that was already seen straight away', () => {
    const queue = {push: vi.fn()};
    const isLoaded = vi.fn(() => true);

    const image = wrapEmoji({queue, isLoaded});

    expect(isLoaded).toHaveBeenCalledWith(new URL(URL_PATH, location.href).href);
    expect(queue.push).not.toHaveBeenCalled();
    expect(image.getAttribute('src')).toBe(URL_PATH);
  });
});
