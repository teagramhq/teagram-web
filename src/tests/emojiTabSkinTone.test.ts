import {afterEach, describe, expect, it, vi} from 'vitest';
import EmojiTab, {appendEmoji} from '@components/emoticonsDropdown/tabs/emoji';
import {attachClickEvent, simulateClickEvent} from '@helpers/dom/clickEvent';
import {getMiddleware} from '@helpers/middleware';

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
  const apiManagerProxy = new Proxy({}, {
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

  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/webp;base64,';
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
  vi.stubGlobal('Worker', WorkerMock);
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  return {apiManagerProxy, rootScope};
});

vi.mock('@lib/apiManagerProxy', () => ({default: mocks.apiManagerProxy}));
vi.mock('@lib/rootScope', () => ({default: mocks.rootScope, BroadcastEvents: {}}));
vi.mock('@lib/appImManager', () => ({default: {}}));
vi.mock('@components/sidebarLeft', () => ({default: {}}));
vi.mock('@components/sidebarRight', () => ({default: {}}));
vi.mock('@components/emoticonsDropdown', () => ({EmoticonsDropdown: class {}}));
vi.mock('@lib/solidjs/hotReloadGuardProvider', () => ({default: vi.fn()}));
vi.mock('@components/popups', () => ({default: class {}}));
vi.mock('@components/popups/premium', () => ({default: {show: vi.fn()}}));
vi.mock('@components/popups/stickers', () => ({default: vi.fn()}));
vi.mock('@stores/stars', () => ({default: () => () => 0}));
vi.mock('@lib/customEmoji/compositorChannels', () => ({ensureCompositor: vi.fn()}));
vi.mock('@lib/customEmoji/compositorMessagePort', () => ({
  default: {addEventListener: vi.fn(), invokeCompositorVoid: vi.fn()}
}));
vi.mock('@helpers/liteMode', () => ({default: {isAvailable: () => false}}));

describe('emoji tab skin tones', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.replaceChildren();
  });

  function createEmojiTab() {
    const saveEmojiVariant = vi.fn();
    const onEmojiSelected = vi.fn();
    const tab = new EmojiTab({
      managers: {appEmojiManager: {saveEmojiVariant}} as any,
      isStandalone: true,
      noRegularEmoji: true,
      noSearch: true,
      noPacks: true
    });
    tab.emoticonsDropdown = {chatInput: {onEmojiSelected}, setIgnoreMouseOut: vi.fn()} as any;

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
    };

    return {tab, element, saveEmojiVariant, onEmojiSelected};
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

  it('inserts the chosen tone once when the menu was opened on the emoji glyph', async() => {
    const {tab, element, saveEmojiVariant, onEmojiSelected} = createEmojiTab();
    const glyph = element.firstElementChild;
    expect(glyph.classList.contains('emoji')).toBe(true);

    await chooseTone(tab, glyph, 4);

    expect(onEmojiSelected).toHaveBeenCalledOnce();
    expect(onEmojiSelected).toHaveBeenCalledWith({emoji: '👋🏾'}, false);
    expect(saveEmojiVariant).toHaveBeenCalledWith('👋', 4);
    expect(element.firstElementChild.getAttribute('alt')).toBe('👋🏾');
  });

  it('inserts the saved tone once on a plain click after a tone choice', async() => {
    const {tab, element, onEmojiSelected} = createEmojiTab();
    await chooseTone(tab, element.firstElementChild, 2);
    onEmojiSelected.mockClear();

    simulateClickEvent(element.firstElementChild as HTMLElement);

    expect(onEmojiSelected).toHaveBeenCalledOnce();
    expect(onEmojiSelected).toHaveBeenCalledWith({emoji: '👋🏼'}, false);
  });
});
