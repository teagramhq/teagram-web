import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import EmojiTab from '@components/emoticonsDropdown/tabs/emoji';
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
    wrapEmojiStatus: vi.fn()
  };
});

vi.mock('@lib/apiManagerProxy', () => ({default: mocks.apiManagerProxy}));
vi.mock('@lib/rootScope', () => ({default: mocks.rootScope, BroadcastEvents: {}}));
vi.mock('@lib/appImManager', () => ({default: {openPremiumBot: mocks.openPremiumBot}}));
vi.mock('@components/sidebarLeft', () => ({default: {}}));
vi.mock('@components/sidebarRight', () => ({default: {}}));
vi.mock('@components/emoticonsDropdown', () => ({EmoticonsDropdown: class {}}));
vi.mock('@lib/solidjs/hotReloadGuardProvider', () => ({default: vi.fn()}));
vi.mock('@components/popups', () => ({default: mocks.PopupElementMock}));
vi.mock('@components/popups/premium', () => ({default: {show: mocks.premiumShow}}));
vi.mock('@components/popups/starGiftInfo', () => ({default: vi.fn()}));
vi.mock('@components/popups/stickers', () => ({default: vi.fn()}));
vi.mock('@components/sidebarLeft/emojiStatusPicker', () => ({openEmojiStatusPicker: mocks.openEmojiStatusPicker}));
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
});
