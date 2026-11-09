import {afterEach, describe, expect, it, vi} from 'vitest';
import I18n from '@lib/langPack';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('language pack formatted links', () => {
  it('routes a Telegram link click through its registered handler', () => {
    const im = vi.fn();
    vi.stubGlobal('im', im);
    const anchor = I18n.superFormatter('[profile](https://t.me/durov)')
    .find((node) => node instanceof HTMLAnchorElement) as HTMLAnchorElement;

    const event = new MouseEvent('click', {bubbles: true, cancelable: true});
    anchor.dispatchEvent(event);

    expect(im).toHaveBeenCalledWith(anchor, event);
  });
});
