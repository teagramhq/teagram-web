import {describe, expect, test, vi} from 'vitest';
import {MessageEntity} from '@layer';
import wrapRichText, {WrapRichTextOptions} from '@lib/richTextProcessor/wrapRichText';

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

function wrapEmoji(lazyEmojiImage?: WrapRichTextOptions['lazyEmojiImage']) {
  const entities = [{_: 'messageEntityEmoji', offset: 0, length: EMOJI.length, unicode: '1f600'}] as unknown as MessageEntity[];
  return wrapRichText(EMOJI, {entities, lazyEmojiImage}).querySelector('img.emoji') as HTMLImageElement;
}

describe('wrapRichText emoji images', () => {
  test('requests the image straight away by default', () => {
    expect(wrapEmoji().getAttribute('src')).toBe(URL_PATH);
  });

  test('hands the image and its url to the caller without a src when lazy', () => {
    const lazyEmojiImage = vi.fn();

    const image = wrapEmoji(lazyEmojiImage);

    expect(image.hasAttribute('src')).toBe(false);
    expect(lazyEmojiImage).toHaveBeenCalledTimes(1);
    expect(lazyEmojiImage).toHaveBeenCalledWith(image, URL_PATH);
  });
});
