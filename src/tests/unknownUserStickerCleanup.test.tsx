import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';

const mocks = vi.hoisted(() => ({
  handleStickerError: vi.fn((error: {type?: string}) => {
    if(error?.type !== 'MIDDLEWARE') console.error(error);
  }),
  wrapAdaptiveCustomEmoji: vi.fn()
}));

vi.mock('@components/chat/bubbles/service.module.scss', () => ({default: {addon: 'addon'}}));
vi.mock('@components/chat/bubbles/unknownUser.module.scss', () => ({
  default: new Proxy({}, {get: (_target, key) => String(key)})
}));
vi.mock('@components/iconTsx', () => ({IconTsx: () => document.createElement('span')}));
vi.mock('@components/peerTitleTsx', () => ({PeerTitleTsx: () => document.createElement('span')}));
vi.mock('@components/sidebarRight', () => ({default: {toggleSidebar: vi.fn()}}));
vi.mock('@components/stackedAvatars', () => ({StackedAvatarsTsx: () => document.createElement('span')}));
vi.mock('@components/wrappers/customEmojiSimple', () => ({
  wrapAdaptiveCustomEmoji: mocks.wrapAdaptiveCustomEmoji
}));
vi.mock('@components/wrappers/sticker', () => ({handleStickerError: mocks.handleStickerError}));
vi.mock('@components/wrappers/wrapDuration', () => ({wrapFormattedDuration: (text: string) => text}));
vi.mock('@helpers/date', () => ({monthsLocalized: []}));
vi.mock('@helpers/formatDuration', () => ({default: (text: string) => text}));
vi.mock('@helpers/solid/i18n', () => ({I18nTsx: () => document.createElement('span')}));
vi.mock('@lib/langPack', () => ({
  default: {countriesList: [{iso2: 'US', name: 'United States'}]},
  i18n: () => document.createElement('span')
}));
vi.mock('@lib/rootScope', () => ({default: {managers: {appUsersManager: {getCommonChats: vi.fn()}}}}));
vi.mock('@lib/richTextProcessor/wrapEmojiText', () => ({default: (text: string) => text}));
vi.mock('@lib/richTextProcessor/wrapRichText', () => ({default: (text: string) => text}));
vi.mock('@vendor/emoji', () => ({getCountryEmoji: () => '🇺🇸'}));

import {UnknownUserBubble} from '@components/chat/bubbles/unknownUser';

describe('UnknownUserBubble sticker cleanup', () => {
  let container: HTMLDivElement;
  let dispose: VoidFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
  });

  afterEach(() => {
    dispose?.();
    vi.restoreAllMocks();
  });

  it('handles cancellation of a bot-verification emoji render without an unhandled rejection', async() => {
    const cancellation = {type: 'MIDDLEWARE'};
    mocks.wrapAdaptiveCustomEmoji.mockReturnValue({
      container: document.createElement('span'),
      loadPromise: Promise.reject(cancellation)
    });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      dispose = render(() => UnknownUserBubble({
        peerId: 2 as PeerId,
        user: {bot_verification_icon: 3, pFlags: {contact: false, verified: true}} as any,
        userFull: {bot_verification: {description: 'Verified bot'}} as any,
        peerSettings: {phone_country: 'US'} as any
      }), container);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mocks.wrapAdaptiveCustomEmoji).toHaveBeenCalledOnce();
      expect(mocks.handleStickerError).toHaveBeenCalledWith(cancellation);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
