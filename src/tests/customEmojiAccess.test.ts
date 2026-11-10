import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import EmojiTab, {appendEmoji} from '@components/emoticonsDropdown/tabs/emoji';
import {attachClickEvent, simulateClickEvent} from '@helpers/dom/clickEvent';
import {getMiddleware} from '@helpers/middleware';
import getRichValueWithCaret from '@helpers/dom/getRichValueWithCaret';
import ChatInput from '@components/chat/input';
import {CustomEmojiRendererElement} from '@lib/customEmoji/renderer';
import PopupPremium from '@components/popups/premium';
import generateTitleIcons from '@components/generateTitleIcons';
import rootScope from '@lib/rootScope';

const mocks = vi.hoisted(() => {
  class IntersectionObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
  }
  class WorkerMock {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    start() {}
    terminate() {}
  }
  const premiumFeaturesHidden = vi.fn();
  const apiManagerProxy = new Proxy({isPremiumFeaturesHidden: premiumFeaturesHidden}, {
    get: (target, property) => Reflect.get(target, property) ?? vi.fn()
  });
  const rootScope = {
    premium: false,
    myId: 0,
    managers: new Proxy({}, {get: () => vi.fn()}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    dispatchEventSingle: vi.fn()
  };
  class PopupElementMock {
    static createPopup = vi.fn();
  }

  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/webp;base64,';
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
  vi.stubGlobal('Worker', WorkerMock);
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  return {
    apiManagerProxy,
    rootScope,
    openPremiumBot: vi.fn(),
    premiumShow: vi.fn(),
    PopupElementMock,
    openEmojiStatusPicker: vi.fn(),
    emojiStatusPickerImportError: undefined as Error | undefined,
    wrapEmojiStatus: vi.fn()
  };
});

vi.mock('@lib/apiManagerProxy', () => ({default: mocks.apiManagerProxy}));
vi.mock('@lib/rootScope', () => ({default: mocks.rootScope, BroadcastEvents: {}}));
vi.mock('@lib/appImManager', () => ({default: {openPremiumBot: mocks.openPremiumBot}}));
vi.mock('@components/sidebarLeft', () => ({default: {}}));
vi.mock('@components/sidebarRight', () => ({default: {}}));
vi.mock('@components/emoticonsDropdown', () => ({default: {}, EmoticonsDropdown: class {}}));
vi.mock('@lib/solidjs/hotReloadGuardProvider', () => ({default: vi.fn()}));
vi.mock('@components/popups', () => ({default: mocks.PopupElementMock}));
vi.mock('@components/popups/premium', () => ({default: {show: mocks.premiumShow}}));
vi.mock('@components/popups/starGiftInfo', () => ({default: vi.fn()}));
vi.mock('@components/popups/stickers', () => ({default: vi.fn()}));
vi.mock('@components/sidebarLeft/emojiStatusPicker', () => {
  if(mocks.emojiStatusPickerImportError) throw mocks.emojiStatusPickerImportError;
  return {openEmojiStatusPicker: mocks.openEmojiStatusPicker};
});
vi.mock('@components/wrappers/emojiStatus', () => ({
  default: mocks.wrapEmojiStatus
}));
vi.mock('@stores/contentSettings', () => ({
  default: () => ({
    sensitiveEnabled: () => false,
    sensitiveCanChange: () => false,
    needAgeVerification: () => false,
    ageVerified: () => false,
    ignoreRestrictionReasons: (): string[] => []
  })
}));
vi.mock('@stores/stars', () => ({default: () => () => 0}));
vi.mock('@lib/lottie/shouldRenderOffscreen', () => ({default: false}));
vi.mock('@lib/customEmoji/compositorChannels', () => ({ensureCompositor: vi.fn()}));
vi.mock('@lib/customEmoji/compositorMessagePort', () => ({
  default: {addEventListener: vi.fn(), invokeCompositorVoid: vi.fn()}
}));
vi.mock('@helpers/liteMode', () => ({default: {isAvailable: () => false}}));

function createStandaloneEmojiTab(managers: any = {}) {
  return new EmojiTab({
    managers,
    isStandalone: true,
    noRegularEmoji: true,
    noSearch: true,
    noPacks: true
  });
}

describe('custom emoji access without Premium', () => {
  let previousPremium: boolean;
  let previousMyId: PeerId;

  beforeEach(() => {
    previousPremium = rootScope.premium;
    previousMyId = rootScope.myId;
    rootScope.premium = false;
    rootScope.myId = 1 as PeerId;
    mocks.wrapEmojiStatus.mockResolvedValue(document.createElement('span'));
  });

  afterEach(() => {
    rootScope.premium = previousPremium;
    rootScope.myId = previousMyId;
    mocks.emojiStatusPickerImportError = undefined;
    vi.clearAllMocks();
  });

  it('shows recent custom emoji in an unlocked non-Premium picker', () => {
    const category = {
      id: '',
      items: [{docId: '42'}],
      mounted: false,
      elements: {
        container: document.createElement('div'),
        menuTab: document.createElement('div')
      }
    } as any;
    const categoriesContainer = document.createElement('div');
    const tab = Object.create(EmojiTab.prototype) as EmojiTab;
    Object.assign(tab, {
      categories: {'': category},
      localCategories: [category],
      categoriesContainer,
      menu: document.createElement('div'),
      content: document.createElement('div'),
      isStandalone: false,
      mainSets: undefined,
      canUsePremiumEmojiAlways: true,
      emoticonsDropdown: {chatInput: {chat: {peerId: 2}}}
    });

    tab.toggleCustomCategory();

    expect(category.mounted).toBe(true);
    expect(category.elements.container.parentElement).toBe(categoriesContainer);
    expect(tab.content.classList.contains('has-premium')).toBe(true);
  });

  it('removes Premium styling only from emoji sets in an unlocked picker', async() => {
    for(const canUsePremiumEmojiAlways of [true, false]) {
      const title = document.createElement('div');
      const category = {
        elements: {
          container: document.createElement('div'),
          title,
          items: document.createElement('div'),
          menuTabPadding: document.createElement('div')
        },
        middlewareHelper: {get: () => vi.fn()},
        setCategoryItemsHeight: vi.fn()
      };
      const tab = Object.create(EmojiTab.prototype) as EmojiTab;
      Object.assign(tab, {
        canUsePremiumEmojiAlways,
        createCategory: vi.fn(() => category),
        positionCategory: vi.fn(),
        createEmojiRendererForCategory: vi.fn(),
        renderStickerSetThumb: vi.fn(),
        isCategoryVisible: vi.fn(() => true),
        onCategoryVisibility: vi.fn(),
        managers: {appStickersManager: {getStickerSet: vi.fn().mockResolvedValue({documents: []})}}
      });

      (tab as any).renderEmojiSet({id: 'set', title: 'Custom emoji', count: 0, pFlags: {emojis: true}});
      await Promise.resolve();

      expect(category.elements.container.classList.contains('is-premium-set')).toBe(!canUsePremiumEmojiAlways);
      if(canUsePremiumEmojiAlways) {
        expect(title.querySelector('.category-title-lock')).toBeNull();
      } else {
        expect(title.querySelector('.category-title-lock')).not.toBeNull();
      }
    }
  });

  it('adds custom emoji to the items container when the real category visibility callback enters view', () => {
    const categoryContainer = document.createElement('div');
    const itemsContainer = document.createElement('div');
    const customEmoji = Object.assign(document.createElement('span'), {docId: '42', clear: vi.fn()});
    const emojiItem = document.createElement('div');
    emojiItem.append(customEmoji);
    const renderer = {add: vi.fn()};
    const category = {
      elements: {container: categoryContainer, items: itemsContainer, renderer},
      items: [{docId: '42', element: emojiItem}]
    };
    const tab = createStandaloneEmojiTab();
    (tab as any).categoriesMap.set(categoryContainer, category);

    try {
      (tab as any).onCategoryVisibility({target: categoryContainer, visible: true});
    } finally {
      tab.destroy();
    }

    expect(itemsContainer.contains(emojiItem)).toBe(true);
    expect(renderer.add).toHaveBeenCalledOnce();
    expect(renderer.add.mock.calls[0][0].addCustomEmojis.get('42')).toEqual(new Set([customEmoji]));
  });

  it('keeps custom emoji on the main-thread canvas when the dedicated mode is enabled', () => {
    const transferControlToOffscreen = vi.fn(() => ({} as OffscreenCanvas));
    const transferDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      configurable: true,
      value: transferControlToOffscreen
    });
    let renderer: CustomEmojiRendererElement;
    try {
      renderer = CustomEmojiRendererElement.create({animationGroup: 'custom-emoji-access-test'} as any);

      expect(renderer.offscreen).toBe(false);
      expect(transferControlToOffscreen).not.toHaveBeenCalled();
    } finally {
      renderer?.destroy();
      if(transferDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', transferDescriptor);
      else delete (HTMLCanvasElement.prototype as any).transferControlToOffscreen;
    }
  });

  it('renders custom emoji status while Premium features are hidden', async() => {
    mocks.apiManagerProxy.isPremiumFeaturesHidden.mockResolvedValue(true);
    const statusIcon = document.createElement('span');
    mocks.wrapEmojiStatus.mockResolvedValue(statusIcon);
    const middleware = Object.assign(() => true, {onDestroy: vi.fn()});

    const {elements} = await generateTitleIcons({
      peerId: 2 as PeerId,
      peer: {
        _: 'user',
        id: 2,
        pFlags: {premium: false},
        emoji_status: {_: 'emojiStatus', document_id: '42'}
      } as any,
      wrapOptions: {middleware} as any
    });

    expect(elements).toContain(statusIcon);
  });

  it('does not open the Premium promo when another account has a custom emoji status', async() => {
    mocks.apiManagerProxy.isPremiumFeaturesHidden.mockResolvedValue(false);
    const statusIcon = document.createElement('span');
    mocks.wrapEmojiStatus.mockResolvedValue(statusIcon);
    const middleware = Object.assign(() => true, {onDestroy: vi.fn()});

    const {elements} = await generateTitleIcons({
      peerId: 2 as PeerId,
      peer: {
        _: 'user',
        id: 2,
        pFlags: {premium: false},
        emoji_status: {_: 'emojiStatus', document_id: '42'}
      } as any,
      wrapOptions: {middleware} as any,
      clickableEmojiStatus: true
    });

    expect(elements).toContain(statusIcon);
    statusIcon.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    statusIcon.click();

    expect(PopupPremium.show).not.toHaveBeenCalled();
  });

  it('reports a failed emoji status picker chunk from a clickable title status', async() => {
    const error = new Error('emoji status picker chunk failed');
    mocks.emojiStatusPickerImportError = error;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const statusIcon = document.createElement('span');
    mocks.wrapEmojiStatus.mockResolvedValue(statusIcon);
    const middleware = Object.assign(() => true, {onDestroy: vi.fn()});

    try {
      await generateTitleIcons({
        peerId: 1 as PeerId,
        peer: {
          _: 'user',
          id: 1,
          pFlags: {premium: false},
          emoji_status: {_: 'emojiStatus', document_id: '42'}
        } as any,
        wrapOptions: {middleware} as any,
        clickableEmojiStatus: true
      });

      statusIcon.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
      statusIcon.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorLog.mock.calls.flat().join(' ')).toContain('Failed to open emoji status picker');
    } finally {
      errorLog.mockRestore();
      mocks.emojiStatusPickerImportError = undefined;
    }
  });
});

describe('emoji tab skin tones', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.replaceChildren();
  });

  // a real composer holding `text` with the caret at `caret`
  function createComposer(text: string, caret: number) {
    const messageInput = document.createElement('div');
    messageInput.contentEditable = 'true';
    messageInput.tabIndex = 0;
    // jsdom implements neither isContentEditable nor execCommand, which the composer relies on
    Object.defineProperty(messageInput, 'isContentEditable', {value: true});
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (command: string, showUI: boolean, html: string) => {
        const selection = document.getSelection();
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const fragment = range.createContextualFragment(html);
        const last = fragment.lastChild;
        range.insertNode(fragment);
        range.setStartAfter(last);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      }
    });
    messageInput.textContent = text;
    document.body.append(messageInput);
    messageInput.focus();
    const range = document.createRange();
    range.setStart(messageInput.firstChild, caret);
    range.collapse(true);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    const chatInput = new ChatInput({peerId: 2} as any, undefined, undefined, 'chat-input');
    Object.assign(chatInput, {messageInput, chatInput: document.createElement('div')});
    return {chatInput, getText: () => getRichValueWithCaret(messageInput).value};
  }

  function createEmojiTab(composerText: string, caret: number) {
    const saveEmojiVariant = vi.fn();
    const tab = createStandaloneEmojiTab({appEmojiManager: {saveEmojiVariant}});
    const {chatInput, getText} = createComposer(composerText, caret);
    tab.emoticonsDropdown = {chatInput, setIgnoreMouseOut: vi.fn()} as any;

    const container = document.createElement('div');
    container.classList.add('emoji-category');
    const element = appendEmoji({emoji: '👋'});
    container.append(element);
    tab.content.append(container);
    document.body.append(tab.content);
    const middlewareHelper = getMiddleware();
    (tab as any).categoriesMap.set(container, {
      items: [{element, emoji: '👋', baseEmoji: '👋'}],
      middlewareHelper
    });

    // the grid click handler that init() attaches
    const detachClick = attachClickEvent(tab.content, (tab as any).onContentClick);
    cleanup = () => {
      detachClick();
      middlewareHelper.destroy();
      tab.destroy();
      delete (document as any).execCommand;
    };

    return {tab, element, saveEmojiVariant, getText};
  }

  async function chooseTone(tab: EmojiTab, glyph: Element, tone: number) {
    const event = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
    glyph.dispatchEvent(event);
    const menu = (tab as any).onContextMenu(event);
    menu.onMenuOpen(document.createElement('div'));
    const buttons = await vi.waitFor(() => {
      const buttons = document.querySelectorAll<HTMLButtonElement>('.emoji-tone-picker-button');
      expect(buttons).toHaveLength(6);
      return buttons;
    });
    simulateClickEvent(buttons[tone]);
  }

  it('inserts the chosen tone once at the composer caret when the menu was opened on the emoji glyph', async() => {
    const {tab, element, saveEmojiVariant, getText} = createEmojiTab('hello world', 6);
    const glyph = element.firstElementChild;
    expect(glyph.classList.contains('emoji')).toBe(true);

    await chooseTone(tab, glyph, 4);

    expect(getText()).toBe('hello 👋🏾world');
    expect(saveEmojiVariant).toHaveBeenCalledWith('👋', 4);
    expect(element.firstElementChild.getAttribute('alt')).toBe('👋🏾');
  });

  it('inserts the saved tone once on a plain click after a tone choice', async() => {
    const {tab, element, getText} = createEmojiTab('hello world', 6);
    await chooseTone(tab, element.firstElementChild, 2);
    expect(getText()).toBe('hello 👋🏼world');

    simulateClickEvent(element.firstElementChild as HTMLElement);

    expect(getText()).toBe('hello 👋🏼👋🏼world');
  });
});
