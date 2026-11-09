import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  wrapAdaptiveCustomEmoji: vi.fn(),
  logError: vi.fn()
}));

vi.mock('@lib/logger', () => ({logger: () => ({error: mocks.logError})}));
vi.mock('@lib/apiManagerProxy', () => ({default: {}}));
vi.mock('@lib/langPack', () => ({i18n: () => document.createElement('span')}));
vi.mock('@lib/rootScope', () => ({default: {addEventListener: vi.fn()}}));
vi.mock('@components/generateFakeIcon', () => ({default: () => document.createElement('div')}));
vi.mock('@components/generatePremiumIcon', () => ({default: () => document.createElement('div')}));
vi.mock('@components/generateVerifiedIcon', () => ({default: () => document.createElement('div')}));
vi.mock('@components/popups', () => ({default: {createPopup: vi.fn()}}));
vi.mock('@components/popups/premium', () => ({default: {show: vi.fn()}}));
vi.mock('@components/popups/starGiftInfo', () => ({default: {}}));
vi.mock('@components/sidebarLeft/emojiStatus', () => ({openEmojiStatusPickerSafely: vi.fn()}));
vi.mock('@components/wrappers/customEmojiSimple', () => ({
  wrapAdaptiveCustomEmoji: mocks.wrapAdaptiveCustomEmoji
}));
vi.mock('@components/wrappers/sticker', () => ({
  ignoreMiddlewareCancellation: (error: {type?: string}) => {
    if(error?.type !== 'MIDDLEWARE') throw error;
  }
}));
vi.mock('@components/wrappers/emojiStatus', () => ({default: vi.fn()}));

import generateTitleIcons from '@components/generateTitleIcons';

describe('generateTitleIcons sticker cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles a cancelled bot-verification emoji render without an unhandled rejection', async() => {
    mocks.wrapAdaptiveCustomEmoji.mockReturnValue({
      container: document.createElement('div'),
      loadPromise: Promise.reject({type: 'MIDDLEWARE'})
    });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await generateTitleIcons({
        peerId: 1 as PeerId,
        peer: {bot_verification_icon: 2, pFlags: {}} as any,
        wrapOptions: {} as WrapSomethingOptions,
        noPremiumIcon: true
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mocks.wrapAdaptiveCustomEmoji).toHaveBeenCalledOnce();
      expect(mocks.logError).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
