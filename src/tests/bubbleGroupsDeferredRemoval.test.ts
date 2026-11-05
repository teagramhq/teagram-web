import {describe, expect, it, vi} from 'vitest';
import type {Message} from '@layer';
import BubbleGroups from '@components/chat/bubbleGroups';
import {ChatType} from '@components/chat/chatType';

vi.mock('@lib/rootScope', () => ({default: {myId: 0}}));
vi.mock('@components/chat/bubbles', () => ({
  default: class ChatBubbles {},
  SERVICE_AS_REGULAR: new Set(),
  STICKY_OFFSET: 0
}));
vi.mock('@components/avatarNew', () => ({avatarNew: vi.fn()}));
vi.mock('@components/chat/utils', () => ({
  getGuestChatViaFromId: (): PeerId => undefined,
  getMid: (message: Message.message) => message.mid,
  isMessage: (message: Message.message) => message._ === 'message',
  isMessageForVerificationBot: (): boolean => false
}));
vi.mock('@appManagers/utils/messages/getMessageThreadId', () => ({default: (): number => undefined}));
vi.mock('@appManagers/utils/peers/getPeerId', () => ({default: (): PeerId => undefined}));
vi.mock('@components/chat/bubbleParts/suggestedPostReplyMarkup', () => ({canHaveSuggestedPostReplyMarkup: () => false}));
vi.mock('@components/chat/bubbleParts/updateChatThreadSeparators', () => ({default: vi.fn()}));

function makeMessage(mid: number, fromId: PeerId): Message.message {
  return {
    _: 'message',
    id: mid,
    mid,
    date: 100,
    fromId,
    peerId: 1 as PeerId,
    peer_id: {_: 'peerChat', chat_id: 1},
    message: '',
    pFlags: {}
  } as Message.message;
}

function createHarness() {
  const chat = {
    type: ChatType.Chat,
    peerId: 1 as PeerId,
    isOutMessage: () => false,
    isAllMessagesForum: false,
    isBotforum: false,
    isMonoforum: false,
    bubbles: {
      getDateForDateContainer: () => ({dateTimestamp: 100000}),
      getMiddleware: () => ({create: () => ({get: vi.fn(), clean: vi.fn()})})
    }
  } as any;
  const groups = new BubbleGroups(chat);
  const bubbles = new Map<number, HTMLElement>();

  for(const [mid, fromId] of [[5, 1], [4, 2], [3, 1]] as const) {
    const bubble = document.createElement('div');
    bubbles.set(mid, bubble);
    groups.prepareForGrouping(bubble, makeMessage(mid, fromId as PeerId), false);
  }

  groups.groupUngrouped();

  const ungroupedBubble = document.createElement('div');
  bubbles.set(1, ungroupedBubble);
  groups.prepareForGrouping(ungroupedBubble, makeMessage(1, 3 as PeerId), false);

  const mountUnmountGroups = vi.spyOn(groups, 'mountUnmountGroups').mockImplementation(() => {});

  return {groups, bubbles, mountUnmountGroups};
}

function getGroupMemberships(groups: BubbleGroups) {
  return groups.groups
  .map((group) => group.items.map((item) => item.mid).sort((a, b) => a - b))
  .sort((group1, group2) => group1[0] - group2[0]);
}

describe('deferred bubble group removal', () => {
  it('tracks regrouped groups and matches immediate removal', () => {
    const immediate = createHarness();
    immediate.groups.removeAndUnmountBubble(immediate.bubbles.get(4));

    const deferred = createHarness();
    const deferredGroups = new Set<Parameters<BubbleGroups['mountUnmountGroups']>[0][number]>();
    deferred.groups.removeAndUnmountBubble(deferred.bubbles.get(4), deferredGroups);

    expect(getGroupMemberships(deferred.groups)).toEqual(getGroupMemberships(immediate.groups));
    expect(getGroupMemberships(deferred.groups)).toEqual([[1], [3, 5]]);
    const regroupedGroup = deferred.groups.getItemByBubble(deferred.bubbles.get(1)).group;
    expect(deferredGroups.has(regroupedGroup)).toBe(true);
    expect(deferred.mountUnmountGroups).not.toHaveBeenCalled();
  });
});
