import {describe, expect, it} from 'vitest';
import {AppMessagesManager} from '@appManagers/appMessagesManager';
import {MessagesMessages, Message} from '@layer';

const manager = Object.create(AppMessagesManager.prototype) as AppMessagesManager;

function plainMessages(length: number): MessagesMessages.messagesMessages {
  return {
    _: 'messages.messages',
    messages: Array.from({length}, (_, index) => ({mid: 1_000 - index}) as Message),
    topics: [],
    chats: [],
    users: []
  };
}

describe('history pagination end detection', () => {
  it('keeps older history available after a full uncounted page', () => {
    const result = manager.isHistoryResultEnd({
      historyResult: plainMessages(50),
      limit: 50,
      addOffset: 0,
      offsetId: 0,
      peerId: 2 as PeerId
    });

    expect(result.isTopEnd).toBe(false);
    expect(result.isBottomEnd).toBe(true);
  });

  it('marks an uncounted short page as the end of older history', () => {
    const result = manager.isHistoryResultEnd({
      historyResult: plainMessages(12),
      limit: 50,
      addOffset: 0,
      offsetId: 0,
      peerId: 2 as PeerId
    });

    expect(result.isTopEnd).toBe(true);
    expect(result.isBottomEnd).toBe(true);
  });
});
