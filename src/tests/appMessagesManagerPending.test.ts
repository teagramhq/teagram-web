import {describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {AppMessagesManager} from '@appManagers/appMessagesManager';

describe('AppMessagesManager pending message reconciliation', () => {
  it('restores the thread dialog top message when a pending message is finalized', () => {
    const manager = new AppMessagesManager() as any;
    const randomId = '42';
    const peerId = 777 as PeerId;
    const tempId = 3.0001;
    const serverId = 4;
    const threadId = 55;
    const pendingData = {peerId, tempId, threadId, storage: {key: '777_history'}};
    const tempMessage = {mid: tempId, _: 'message', pFlags: {is_outgoing: true}};
    const serverMessage = {mid: serverId, peerId, _: 'message', pFlags: {is_outgoing: true}};
    const threadDialog = {_: 'forumTopic', top_message: tempId};
    const setDialogTopMessage = vi.fn();

    Object.assign(manager, {
      pendingByRandomId: {[randomId]: pendingData},
      getHistoryStorage: () => ({history: {delete: vi.fn()}}),
      getMessageFromStorage: (_storage: unknown, mid: number) => mid === tempId ? tempMessage : undefined,
      updateMessageContextForDeletion: vi.fn(),
      getDialogOnly: (): undefined => undefined,
      dialogsStorage: {getAnyDialog: () => threadDialog},
      setDialogTopMessage,
      rootScope: {dispatchEvent: vi.fn()},
      deletePendingTopMsg: vi.fn(),
      finalizePendingMessageCallbacks: vi.fn()
    });

    manager.finalizePendingMessage(randomId, serverMessage);

    expect(setDialogTopMessage).toHaveBeenCalledWith(serverMessage, threadDialog);
  });

  it('finalizes a pending message when its server ID arrives after the server message', () => {
    const manager = new AppMessagesManager() as any;
    const randomId = '42';
    const peerId = 777 as PeerId;
    const tempId = 3.0001;
    const serverId = 4;
    const pendingData = {
      peerId,
      tempId,
      storage: {key: '777_history'},
      sequential: false
    };
    const tempMessage = {mid: tempId, _: 'message', pFlags: {is_outgoing: true}};
    const serverMessage = {mid: serverId, _: 'message', pFlags: {is_outgoing: true}};
    const historyDelete = vi.fn();
    const dispatchEvent = vi.fn();

    Object.assign(manager, {
      pendingByRandomId: {[randomId]: pendingData},
      pendingByMessageId: {},
      appPeersManager: {isChannel: () => false},
      appMessagesIdsManager: {generateMessageId: (id: number) => id},
      getMessageFromStorage: (_storage: unknown, mid: number) =>
        mid === tempId ? tempMessage : mid === serverId ? serverMessage : undefined,
      getDialogOnly: (): undefined => undefined,
      getHistoryStorage: () => ({history: {delete: historyDelete}}),
      updateMessageContextForDeletion: vi.fn(),
      rootScope: {dispatchEvent},
      deletePendingTopMsg: vi.fn(),
      finalizePendingMessageCallbacks: vi.fn(),
      adoptStreamedMessageDraft: vi.fn()
    });

    manager.checkPendingMessage(serverMessage);
    expect(manager.pendingByRandomId[randomId]).toBe(pendingData);

    manager.onUpdateMessageId({random_id: randomId, id: serverId});

    expect(manager.pendingByRandomId[randomId]).toBeUndefined();
    expect(historyDelete).toHaveBeenCalledWith(tempId);
    expect(dispatchEvent).toHaveBeenCalledWith('history_update', expect.objectContaining({
      storageKey: '777_history',
      message: serverMessage,
      tempId
    }));
  });
});
