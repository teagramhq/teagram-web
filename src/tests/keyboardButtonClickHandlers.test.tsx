import {afterEach, describe, expect, it, vi} from 'vitest';
import type Chat from '@components/chat/chat';
import wrapKeyboardButton from '@components/wrappers/keyboardButton';
import type {KeyboardButton} from '@layer';

vi.mock('@lib/apiManagerProxy', () => ({default: {addEventListener: () => {}, getState: () => Promise.resolve({})}}));
vi.mock('@lib/rootScope', () => ({default: {managers: {}}}));
vi.mock('@lib/langPack', () => ({i18n: () => document.createDocumentFragment()}));
vi.mock('@lib/richTextProcessor/wrapRichText', () => ({
  default: (text: string, options?: {entities?: Array<{url: string}>}) => {
    if(!options?.entities?.length) {
      const fragment = document.createDocumentFragment();
      fragment.append(text);
      return fragment;
    }

    const anchor = document.createElement('a');
    const url = options.entities[0].url;
    anchor.href = url;
    anchor.classList.add('anchor-url');
    anchor.dataset.clickHandler = url.startsWith('https://t.me/') ? 'im' : 'showMaskedAlert';
    const fragment = document.createDocumentFragment();
    fragment.append(anchor);
    return fragment;
  }
}));
vi.mock('@components/chat/chat', () => ({default: class Chat {}}));
vi.mock('@components/popups/pickUser', () => ({showPickUser3Popup: vi.fn()}));
vi.mock('@components/popups/requestPeer', () => ({default: vi.fn()}));
vi.mock('@components/toast', () => ({toast: vi.fn(), toastNew: vi.fn()}));
vi.mock('@components/wrappers/customEmoji', () => ({default: () => document.createElement('span')}));
vi.mock('@components/popups/createBot', () => ({default: vi.fn()}));
vi.mock('@components/confirmationPopup', () => ({default: vi.fn()}));
vi.mock('@lib/solidjs/hotReloadGuardProvider', () => ({default: (): null => null}));
vi.mock('@components/chat/bubbleParts/replyMarkupLayout', () => ({
  default: {
    Button: (props: {as?: 'button' | 'a', ref?: (element: HTMLElement) => void, onClick?: (event: Event) => void, children: Node}): HTMLElement => {
      const element = document.createElement(props.as || 'button');
      props.ref?.(element);
      if(props.children) element.append(props.children);
      if(props.onClick) element.addEventListener('click', props.onClick);
      return element;
    }
  }
}));

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
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: () => ({matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}})
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('keyboard URL buttons', () => {
  it('keeps masked-link warnings and Telegram routing after copying the source anchor', () => {
    const showMaskedAlert = vi.fn();
    const im = vi.fn();
    vi.stubGlobal('showMaskedAlert', showMaskedAlert);
    vi.stubGlobal('im', im);

    const chat = {peerId: 1 as PeerId} as Chat;
    const maskedButton: KeyboardButton.keyboardButtonUrl = {
      _: 'keyboardButtonUrl',
      text: 'Open details',
      url: 'https://example.com/real-destination'
    };
    const telegramButton: KeyboardButton.keyboardButtonUrl = {
      _: 'keyboardButtonUrl',
      text: 'Open profile',
      url: 'https://t.me/durov'
    };
    const container = document.createElement('div');
    const maskedAnchor = wrapKeyboardButton({button: maskedButton, chat}) as HTMLAnchorElement;
    const telegramAnchor = wrapKeyboardButton({button: telegramButton, chat}) as HTMLAnchorElement;
    container.append(maskedAnchor, telegramAnchor);

    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors).toEqual([maskedAnchor, telegramAnchor]);
    expect(maskedAnchor.dataset.clickHandler).toBe('showMaskedAlert');
    expect(telegramAnchor.dataset.clickHandler).toBe('im');

    const maskedEvent = new MouseEvent('click', {bubbles: true, cancelable: true});
    const telegramEvent = new MouseEvent('click', {bubbles: true, cancelable: true});
    maskedAnchor.dispatchEvent(maskedEvent);
    telegramAnchor.dispatchEvent(telegramEvent);

    expect(showMaskedAlert).toHaveBeenCalledWith(maskedAnchor, maskedEvent);
    expect(im).toHaveBeenCalledWith(telegramAnchor, telegramEvent);
  });
});
