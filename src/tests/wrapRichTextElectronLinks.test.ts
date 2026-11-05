import {afterEach, describe, expect, test, vi} from 'vitest';
import wrapRichText from '@lib/richTextProcessor/wrapRichText';
import {MessageEntity} from '@layer';
import {handleStickerSetShareLinkClick, resolveStickerSetShareLink, setStickerSetLinkPrefix} from '@helpers/stickerSetLink';

// wrapRichText reaches the worker proxy through langPack; none of that is needed to build a link
vi.mock('@lib/apiManagerProxy', () => ({default: {addEventListener: () => {}, getState: () => Promise.resolve({})}}));

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

  // jsdom has no canvas backend; the environment probes wrapRichText pulls in need a string back
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

  Object.defineProperty(globalThis, 'Worker', {configurable: true, writable: true, value: class Worker {}});
  Object.defineProperty(globalThis, 'CSS', {configurable: true, value: {supports: () => true}});
});

// A URL that breaks out of a single-quoted JS string literal if it is ever interpolated into one.
const BREAKOUT_URL = 'https://example.invalid/\'+alert(document.domain)+\'';

function wrapUrlEntity(url: string) {
  const entities: MessageEntity[] = [{_: 'messageEntityUrl', offset: 0, length: url.length}];
  const fragment = wrapRichText(url, {entities, passMaskedLinks: true});
  return fragment.querySelector('a.anchor-url');
}

function wrapTextUrlEntity(text: string, url: string) {
  const entities: MessageEntity[] = [{_: 'messageEntityTextUrl', offset: 0, length: text.length, url}];
  const fragment = wrapRichText(text, {entities});
  return fragment.querySelector('a.anchor-url');
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = '';
});

describe('wrapRichText external links', () => {
  test('a message cannot forge the Electron bridge by clobbering the global', () => {
    // Stage 1 of the report: LaTeX `\label{electronHelpers}` renders as an element carrying that
    // id, and a browser exposes every id on `window` — so a bare `typeof electronHelpers` sees an
    // element. jsdom does not implement those named properties, so bind the element by hand.
    vi.stubGlobal('electronHelpers', document.createElement('mtr'));

    const anchor = wrapUrlEntity(BREAKOUT_URL);
    expect(anchor.getAttribute('href')).toEqual(BREAKOUT_URL);
    expect(anchor.getAttribute('href').startsWith('javascript:')).toBe(false);
    expect(anchor.getAttribute('target')).toEqual('_blank');
  });

  test('the real Electron bridge gets the URL as data, never as markup', () => {
    const openExternal = vi.fn();
    vi.stubGlobal('electronHelpers', {openExternal});

    const anchor = wrapUrlEntity(BREAKOUT_URL);
    expect(anchor.getAttribute('href')).toEqual(BREAKOUT_URL);
    expect(anchor.getAttribute('href').startsWith('javascript:')).toBe(false);
    // opening happens through the bridge, so the link must not navigate the app window itself
    expect(anchor.getAttribute('target')).toBeNull();

    document.body.append(anchor);
    const event = new MouseEvent('click', {bubbles: true, cancelable: true});
    anchor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(BREAKOUT_URL);
  });

  test('links open in a new tab when there is no bridge', () => {
    const anchor = wrapUrlEntity('https://example.invalid/plain');
    expect(anchor.getAttribute('href')).toEqual('https://example.invalid/plain');
    expect(anchor.getAttribute('target')).toEqual('_blank');
    expect(anchor.getAttribute('rel')).toEqual('noopener noreferrer');
  });

  test('a longer host beginning with t.me stays an external link', () => {
    vi.stubGlobal('im', vi.fn());

    const anchor = wrapUrlEntity('https://t.me.evil.com/durov');
    expect(anchor.getAttribute('href')).toEqual('https://t.me.evil.com/durov');
    expect(anchor.getAttribute('onclick')).toBeNull();
    expect(anchor.getAttribute('target')).toEqual('_blank');
    expect(anchor.getAttribute('rel')).toEqual('noopener noreferrer');
  });

  test('a concealed link on a longer host beginning with t.me keeps the external-link alert', () => {
    vi.stubGlobal('im', vi.fn());

    const anchor = wrapTextUrlEntity('t.me/durov', 'https://t.me.evil.com/durov');
    expect(anchor.getAttribute('href')).toEqual('https://t.me.evil.com/durov');
    expect(anchor.getAttribute('onclick')).toEqual('showMaskedAlert(this)');
    expect(anchor.getAttribute('target')).toEqual('_blank');
    expect(anchor.getAttribute('rel')).toEqual('noopener noreferrer');
  });

  test('an exact t.me host keeps its internal link handler', () => {
    vi.stubGlobal('im', vi.fn());

    const anchor = wrapUrlEntity('https://t.me/durov');
    expect(anchor.getAttribute('onclick')).toEqual('im(this)');
    expect(anchor.getAttribute('target')).toBeNull();
  });

  test('masked and unmasked sticker links rendered before config resolves use the prefix at click time', () => {
    vi.stubGlobal('stickerSet', vi.fn());
    vi.stubGlobal('showMaskedAlert', vi.fn());

    const chatAnchor = wrapUrlEntity('https://links.teagram.test/addstickers/cats_a') as HTMLAnchorElement;
    const maskedAnchor = wrapTextUrlEntity('sticker pack', 'https://links.teagram.test/addstickers/dogs_b') as HTMLAnchorElement;
    document.body.append(chatAnchor, maskedAnchor);

    expect(chatAnchor.getAttribute('onclick')).toBe('stickerSet(this,event)');
    expect(chatAnchor.getAttribute('target')).toBe('_blank');
    expect(maskedAnchor.getAttribute('onclick')).toBe('stickerSet(this,event)');
    expect(maskedAnchor.getAttribute('target')).toBe('_blank');

    const querySelectorAll = vi.spyOn(document, 'querySelectorAll');
    setStickerSetLinkPrefix('https://links.teagram.test/');

    expect(chatAnchor.getAttribute('onclick')).toBe('stickerSet(this,event)');
    expect(chatAnchor.getAttribute('target')).toBe('_blank');
    expect(maskedAnchor.getAttribute('onclick')).toBe('stickerSet(this,event)');
    expect(maskedAnchor.getAttribute('target')).toBe('_blank');
    expect(resolveStickerSetShareLink(chatAnchor.href)).toEqual({shortName: 'cats_a', isEmoji: false});
    expect(resolveStickerSetShareLink(maskedAnchor.href)).toEqual({shortName: 'dogs_b', isEmoji: false});

    const openStickerSet = vi.fn();
    const showMaskedAlert = vi.fn();
    handleStickerSetShareLinkClick(maskedAnchor.href, true, openStickerSet, showMaskedAlert);
    expect(openStickerSet).toHaveBeenCalledWith({shortName: 'dogs_b', isEmoji: false});
    expect(showMaskedAlert).not.toHaveBeenCalled();

    setStickerSetLinkPrefix('https://other-links.teagram.test/');
    handleStickerSetShareLinkClick(maskedAnchor.href, true, openStickerSet, showMaskedAlert);
    expect(showMaskedAlert).toHaveBeenCalledTimes(1);
    expect(querySelectorAll).not.toHaveBeenCalled();
    querySelectorAll.mockRestore();
  });

  test('setting the sticker link prefix does not scan rendered message anchors', () => {
    vi.stubGlobal('stickerSet', vi.fn());
    document.body.append(document.createElement('a'));
    const querySelectorAll = vi.spyOn(document, 'querySelectorAll');

    setStickerSetLinkPrefix('https://links.teagram.test/');

    expect(querySelectorAll).not.toHaveBeenCalled();
    querySelectorAll.mockRestore();
  });

  test('a link the URL parser rejects still renders as an external link', () => {
    vi.stubGlobal('im', vi.fn());

    // a port out of range parses nowhere. `wrapRichText` does not catch around `wrapUrl`, so this
    // used to throw straight out of the render and blank every message quoting such a link
    const url = 'https://t.me:99999/durov';
    let anchor: Element;
    expect(() => anchor = wrapUrlEntity(url)).not.toThrow();
    expect(anchor.getAttribute('onclick')).toBeNull();
    expect(anchor.getAttribute('target')).toEqual('_blank');
    expect(anchor.getAttribute('rel')).toEqual('noopener noreferrer');
  });
});
