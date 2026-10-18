import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';
import type {ChannelParticipant} from '@layer';
import '@helpers/peerIdPolyfill';

const mocks = vi.hoisted(() => ({
  appConfig: vi.fn(),
  availableReactions: vi.fn(),
  channelParticipants: vi.fn(),
  chat: vi.fn(),
  chatFull: vi.fn(),
  collected: undefined as Promise<void> | undefined,
  joinedCommunities: vi.fn(),
  listeners: new Map<string, Set<(value: any) => void>>(),
  tab: undefined as any
}));

vi.mock('@components/avatarEdit', () => ({
  default: class {
    container = document.createElement('div');
    clear = vi.fn();
    constructor() {}
  }
}));

vi.mock('@components/badge', () => ({default: (): null => null}));
vi.mock('@components/buttonTsx', () => {
  const Button: any = (): null => null;
  Button.Corner = (): null => null;
  return {default: Button};
});
vi.mock('@components/checkboxFieldTsx', () => ({default: (): null => null}));
vi.mock('@components/iconTsx', () => ({IconTsx: (): null => null}));
vi.mock('@components/inputFieldTsx', () => ({InputFieldTsx: (): null => null}));
vi.mock('@components/openBoosts', () => ({default: vi.fn()}));
vi.mock('@components/popups/channelsTooMuch', () => ({handleChannelsTooMuch: vi.fn()}));
vi.mock('@components/rowTsx', () => {
  const Row = (props: any) => <div class="row">{props.children}</div>;
  Row.Icon = (): null => null;
  Row.Title = (props: any) => <span>{props.children}</span>;
  Row.Subtitle = (props: any) => <span class="subtitle">{props.children}</span>;
  Row.CheckboxFieldToggle = (props: any) => <div>{props.children}</div>;
  return {default: Row};
});
vi.mock('@components/section', () => ({
  default: (props: any) => <section>{props.children}</section>
}));
vi.mock('@components/solidJsTabs', () => ({AppDirectMessagesTab: {}}));
vi.mock('@components/solidJsTabs/promiseCollector', () => ({
  usePromiseCollector: () => ({
    collect: (promise: Promise<void>) => {
      mocks.collected = promise;
    }
  })
}));
vi.mock('@components/solidJsTabs/superTabProvider', () => ({
  useSuperTab: () => [mocks.tab]
}));
vi.mock('@components/solidJsTabs/tabs', () => {
  const tab = {};
  return {
    AppAddGroupToCommunityTab: tab,
    AppAdminRecentActionsTab: tab,
    AppChatAdministratorsTab: tab,
    AppChatDiscussionTab: tab,
    AppChatInviteLinksTab: tab,
    AppChatMembersTab: tab,
    AppChatReactionsTab: tab,
    AppChatRequestsTab: tab,
    AppChatTypeTab: tab,
    AppEditChatTab: class {},
    AppGroupPermissionsTab: tab,
    AppGroupStickersTab: tab,
    AppRemovedUsersTab: tab
  };
});
vi.mock('@components/stars/transactionHistory', () => ({default: (): null => null}));
vi.mock('@appManagers/utils/chats/getParticipantsCount', () => ({default: () => 4}));
vi.mock('@appManagers/utils/chats/hasRights', () => ({default: () => true}));
vi.mock('@helpers/dom/anchorCallback', () => ({default: vi.fn()}));
vi.mock('@helpers/dom/cancelEvent', () => ({default: vi.fn()}));
vi.mock('@helpers/number/numberThousandSplitter', () => ({
  default: (count: number) => String(count),
  numberThousandSplitterForStars: (count: number) => String(count)
}));
vi.mock('@helpers/solid/subscribeOn', () => ({
  subscribeOn: (target: any) => (event: any, callback: (value: any) => void) => {
    target.addEventListener(event, callback);
  }
}));
vi.mock('@lib/appManagers/utils/chats/isParticipantAdmin', () => ({
  isParticipantAdmin: () => false
}));
vi.mock('@lib/appManagers/utils/peers/getPeerActiveUsernames', () => ({
  default: (): string[] => []
}));
vi.mock('@lib/rootScope', () => ({
  default: {
    addEventListener: (event: string, callback: (value: any) => void) => {
      const listeners = mocks.listeners.get(event) ?? new Set();
      listeners.add(callback);
      mocks.listeners.set(event, listeners);
    },
    removeEventListener: (event: string, callback: (value: any) => void) => {
      mocks.listeners.get(event)?.delete(callback);
    },
    dispatchEvent: (event: string, value: any) => {
      mocks.listeners.get(event)?.forEach((callback) => callback(value));
    }
  }
}));
vi.mock('@lib/solidjs/hotReloadGuard', () => ({
  useHotReloadGuard: () => ({
    AvatarNewTsx: (): null => null,
    ChatType: {Logs: 'logs'},
    CommunityLinkSection: (): null => null,
    I18n: {format: (): string => ''},
    PeerTitleTsx: (): null => null,
    PopupElement: {createPopup: vi.fn()},
    apiManagerProxy: {getChat: (): undefined => undefined},
    appDialogsManager: {},
    appImManager: {setInnerPeer: vi.fn()},
    confirmationPopup: vi.fn(),
    hideToast: vi.fn(),
    i18n: (key: string) => key,
    join: () => '',
    toastNew: vi.fn(),
    wrapEmojiText: (text: string) => text
  })
}));
vi.mock('@stores/appSettings', () => ({appSettings: {logsDiffView: false}}));

import EditChatTab from '@components/sidebarRight/tabs/editChat';
import rootScope from '@lib/rootScope';

const chatId = 11 as ChatId;
const participantId = 20 as UserId;

function makeBannedParticipant(): ChannelParticipant.channelParticipantBanned {
  return {
    _: 'channelParticipantBanned',
    pFlags: {left: true},
    peer: {_: 'peerUser', user_id: participantId},
    kicked_by: 1 as UserId,
    date: 1,
    banned_rights: {
      _: 'chatBannedRights',
      pFlags: {view_messages: true},
      until_date: 0
    }
  };
}

function findRemovedUsersSubtitle(container: HTMLElement) {
  const row = Array.from(container.querySelectorAll('.row')).find((element) => {
    return element.textContent?.includes('ChannelBlockedUsers');
  });
  return row?.querySelector('.subtitle')?.textContent;
}

describe('EditChat removed users summary', () => {
  let container: HTMLDivElement;
  let dispose: VoidFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.collected = undefined;
    mocks.chat.mockResolvedValue({
      _: 'channel',
      id: chatId,
      access_hash: '1',
      title: 'Test channel',
      photo: {_: 'chatPhotoEmpty'},
      date: 1,
      pFlags: {creator: true, broadcast: true}
    });
    mocks.chatFull.mockResolvedValue({
      _: 'channelFull',
      id: chatId,
      about: '',
      pFlags: {},
      participants_count: 4,
      admins_count: 1,
      kicked_count: 0,
      available_reactions: {_: 'chatReactionsNone'}
    });
    mocks.appConfig.mockResolvedValue({
      forum_upgrade_participants_min: 100,
      group_emoji_stickers_level_min: 0,
      channel_autotranslation_level_min: 0
    });
    mocks.availableReactions.mockResolvedValue([]);
    mocks.channelParticipants.mockResolvedValue({
      _: 'channels.channelParticipants',
      count: 1,
      participants: [makeBannedParticipant()],
      chats: [],
      users: []
    });
    mocks.joinedCommunities.mockResolvedValue([]);
    container = document.createElement('div');
    document.body.append(container);
    mocks.tab = {
      close: vi.fn(),
      container: document.createElement('div'),
      content: document.createElement('div'),
      managers: {
        appChatsManager: {getChat: mocks.chat},
        appCommunitiesManager: {getJoinedCommunities: mocks.joinedCommunities},
        appProfileManager: {
          getChatFull: mocks.chatFull,
          getChannelParticipants: mocks.channelParticipants
        },
        appReactionsManager: {getAvailableReactions: mocks.availableReactions},
        apiManager: {getAppConfig: mocks.appConfig}
      },
      payload: {chatId},
      slider: {createTab: vi.fn()}
    };
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
    mocks.listeners.clear();
  });

  async function renderTab() {
    dispose = render(() => <EditChatTab />, container);
    await mocks.collected;
  }

  it('shows the banned-member list count when channelFull reports zero', async() => {
    await renderTab();

    expect(findRemovedUsersSubtitle(container)).toBe('1');
    expect(mocks.channelParticipants).toHaveBeenCalledWith({
      id: chatId,
      filter: {_: 'channelParticipantsKicked', q: ''},
      limit: 1,
      offset: 0
    });
  });

  it('refreshes the count after a ban in the current session', async() => {
    mocks.channelParticipants
    .mockResolvedValueOnce({count: 0, participants: []})
    .mockResolvedValueOnce({count: 1, participants: [makeBannedParticipant()]});
    await renderTab();
    expect(findRemovedUsersSubtitle(container)).toBe('NoBlockedUsers');

    rootScope.dispatchEvent('chat_participant', {channel_id: chatId} as any);

    await vi.waitFor(() => {
      expect(findRemovedUsersSubtitle(container)).toBe('1');
    });
  });
});
