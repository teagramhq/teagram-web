import type {DocumentAttribute} from '@layer';

const mocks = vi.hoisted(() => {
  class FakeIntersectionObserver {
    public observe() {}
    public disconnect() {}
    public unobserve() {}
    public takeRecords(): IntersectionObserverEntry[] { return []; }
  }

  class FakeLottiePlayer {
    public maxFrame = 1;
    public listeners: Record<string, ((value: number) => void)[]> = {};
    public firstFrameCallback: () => void;

    public addEventListener(name: string, callback: (value: number) => void) {
      (this.listeners[name] ??= []).push(callback);
    }

    public onFirstFrame(callback: () => void) {
      this.firstFrameCallback = callback;
      callback();
    }

    public play() {}

    public remove() {}
  }

  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

  return {
    FakeLottiePlayer,
    getReaction: vi.fn(),
    getCacheContext: vi.fn(),
    loadAnimationAsAsset: vi.fn(),
    wrapSticker: vi.fn(),
    wrapStickerAnimation: vi.fn()
  };
});

vi.mock('@lib/rootScope', () => ({
  default: {addEventListener: vi.fn(), managers: {}}
}));
vi.mock('@lib/appImManager', () => ({default: {}}));
vi.mock('@environment/userAgent', () => ({IS_MOBILE: false, IS_SAFARI: false}));
vi.mock('@lib/apiManagerProxy', () => ({
  default: {
    getReaction: mocks.getReaction,
    getCacheContext: mocks.getCacheContext
  }
}));
vi.mock('@lib/liteMode', () => ({default: {isAvailable: () => true}}));
vi.mock('@helpers/liteMode', () => ({default: {isAvailable: () => true}}));
vi.mock('@environment/webpSupport', () => ({default: true}));
vi.mock('@lib/lottie/lottieLoader', () => ({default: {loadAnimationAsAsset: mocks.loadAnimationAsAsset}}));
vi.mock('@lib/lottie/lottiePlayer', () => ({default: mocks.FakeLottiePlayer}));
vi.mock('@lib/appDownloadManager', () => ({default: {downloadMediaURL: vi.fn()}}));
vi.mock('@lib/customEmoji/element', () => ({default: {create: vi.fn()}}));
vi.mock('@lib/richTextProcessor/wrapEmojiText', () => ({default: (text: string) => text}));
vi.mock('@lib/richTextProcessor/fixEmoji', () => ({default: (text: string) => text, cleanEmoji: (text: string) => text}));
vi.mock('@lib/langPack', () => ({i18n: () => document.createElement('span')}));
vi.mock('@helpers/dom/anchorCallback', () => ({default: vi.fn()}));
vi.mock('@helpers/contextMenuController', () => ({default: {close: vi.fn()}}));
vi.mock('@helpers/middleware', () => ({getMiddleware: vi.fn()}));
vi.mock('@helpers/getImageFromStrippedThumb', () => ({default: vi.fn()}));
vi.mock('@helpers/number/formatNumber', () => ({default: (value: number) => String(value)}));
vi.mock('@helpers/number/getUnsafeRandomInt', () => ({default: () => 1}));
vi.mock('@components/singleTransition', () => ({default: vi.fn()}));
vi.mock('@components/stackedAvatars', () => ({default: class {}}));
vi.mock('@components/buttonIcon', () => ({default: () => document.createElement('button')}));
vi.mock('@components/emoticonsDropdown', () => ({EmoticonsDropdown: class {}}));
vi.mock('@components/emoticonsDropdown/tabs/emoji', () => ({default: class {}}));
vi.mock('@components/popups/premium', () => ({default: {show: vi.fn()}}));
vi.mock('@components/popups/stars', () => ({StarsStar: () => document.createElement('div')}));
vi.mock('@components/sparkles', () => ({Sparkles: () => document.createElement('div')}));
vi.mock('@components/animationIntersector', () => ({
  default: {setOverrideIdleGroup: vi.fn(), checkAnimations: vi.fn(), addAnimation: vi.fn()}
}));
vi.mock('@components/wrappers/sticker', () => ({default: mocks.wrapSticker}));
vi.mock('@components/wrappers/stickerAnimation', () => ({default: mocks.wrapStickerAnimation}));
vi.mock('@components/chat/reactions', () => ({savedReactionTags: []}));

import ReactionElement from '@components/chat/reaction';

describe('reaction animation cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cleans up a static reaction icon without a fastRaf callback error', async() => {
    const staticIcon = {
      _: 'document',
      id: '1',
      access_hash: '1',
      file_reference: new Uint8Array(),
      date: 1,
      mime_type: 'image/webp',
      size: 1,
      dc_id: 1,
      attributes: [] as DocumentAttribute[]
    };
    const animation = {...staticIcon, id: '2', mime_type: 'application/x-tgsticker'};
    mocks.getReaction.mockReturnValue({
      _: 'availableReaction',
      reaction: '👍',
      title: 'Thumbs Up',
      pFlags: {},
      static_icon: staticIcon,
      center_icon: staticIcon,
      around_animation: animation
    });
    mocks.getCacheContext.mockReturnValue({downloaded: true, url: 'blob:reaction'});

    const image = document.createElement('img');
    mocks.wrapSticker.mockImplementation(async({div}: {div: HTMLElement | HTMLElement[]}) => {
      (Array.isArray(div) ? div[0] : div).append(image);
      return {render: Promise.resolve([image])};
    });
    const aroundPlayer = new mocks.FakeLottiePlayer();
    mocks.wrapStickerAnimation.mockImplementation(() => ({
      animationDiv: document.createElement('div'),
      stickerPromise: Promise.resolve(aroundPlayer)
    }));

    const middlewareCallbacks: (() => void)[] = [];
    const middleware = {onDestroy: (callback: () => void) => middlewareCallbacks.push(callback)} as any;
    const cache = {} as any;
    const container = document.createElement('div');
    const callbackError = vi.spyOn(console, 'error').mockImplementation(() => {});

    ReactionElement.fireAroundAnimation({
      cache,
      reaction: {_: 'reactionEmoji', emoticon: '👍'},
      managers: {} as any,
      middleware,
      stickerContainer: container,
      sizes: {genericEffect: 100, genericEffectSize: 100, size: 40, effectSize: 80}
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mocks.getReaction).toHaveBeenCalledOnce();
    expect(mocks.wrapSticker).toHaveBeenCalledOnce();
    expect(middlewareCallbacks).toHaveLength(2);
    expect(aroundPlayer.listeners.enterFrame).toHaveLength(1);
    aroundPlayer.listeners.enterFrame.forEach((callback) => callback(aroundPlayer.maxFrame));
    middlewareCallbacks.forEach((callback) => callback());

    expect(callbackError).not.toHaveBeenCalled();
    expect(image.isConnected).toBe(false);
  });

  it('removes the paid reaction asset player when its overlay is destroyed', async() => {
    const aroundPlayer = new mocks.FakeLottiePlayer();
    const removePlayer = vi.spyOn(aroundPlayer, 'remove');
    let overlay: HTMLElement | undefined;
    mocks.loadAnimationAsAsset.mockImplementation(({container}: {container: HTMLElement}) => {
      overlay = container;
      return Promise.resolve(aroundPlayer);
    });

    const middlewareCallbacks: (() => void)[] = [];
    const middleware = {onDestroy: (callback: () => void) => middlewareCallbacks.push(callback)} as any;
    const cache = {} as any;
    const container = document.createElement('div');

    ReactionElement.fireAroundAnimation({
      cache,
      reaction: {_: 'reactionPaid'},
      managers: {} as any,
      middleware,
      stickerContainer: container,
      sizes: {genericEffect: 100, genericEffectSize: 100, size: 40, effectSize: 80}
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mocks.loadAnimationAsAsset).toHaveBeenCalledOnce();
    expect(middlewareCallbacks).toHaveLength(2);
    expect(overlay).toBeDefined();
    expect(container.contains(overlay!)).toBe(true);

    middlewareCallbacks.forEach((callback) => callback());

    expect(removePlayer).toHaveBeenCalledOnce();
    expect(container.contains(overlay!)).toBe(false);
  });
});
