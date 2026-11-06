import {describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {AppMessagesManager} from '@appManagers/appMessagesManager';

describe('AppMessagesManager pending message reconciliation', () => {
  it.each([
    {echoBeforeRegistration: false, echoOrder: 'after'},
    {echoBeforeRegistration: true, echoOrder: 'before'}
  ])('reconciles an early ID acknowledgement when the server echo arrives $echoOrder pending registration', ({echoBeforeRegistration}) => {
    const manager = new AppMessagesManager() as any;
    const randomId = '42';
    const peerId = 777 as PeerId;
    const tempId = 3.0001;
    const serverId = 4;
    const tempMessage = {id: tempId, mid: tempId, peerId, random_id: randomId, _: 'message', pFlags: {is_outgoing: true}};
    const serverMessage = {mid: serverId, _: 'message', pFlags: {is_outgoing: true}};
    const history = [] as number[];
    const historyStorage = {
      key: '777_history',
      history: {
        unshift: (mid: number) => history.unshift(mid),
        delete: vi.fn((mid: number) => history.splice(history.indexOf(mid), 1))
      }
    };
    const storedMessages = new Map<number, any>();
    const dispatchEvent = vi.fn();

    Object.assign(manager, {
      pendingByRandomId: {},
      pendingByMessageId: {},
      appPeersManager: {isChannel: () => false},
      appMessagesIdsManager: {generateMessageId: (id: number) => id},
      getMessagePeer: () => peerId,
      getHistoryMessagesStorage: () => historyStorage,
      getHistoryStorage: () => historyStorage,
      getMonoforumThreadId: (): undefined => undefined,
      saveMessages: (messages: any[]) => messages.forEach((message) => storedMessages.set(message.mid, message)),
      getMessageFromStorage: (_storage: unknown, mid: number) => storedMessages.get(mid),
      getDialogOnly: (): undefined => undefined,
      setDialogTopMessage: vi.fn(),
      updateMessageContextForInserting: vi.fn(),
      updateMessageContextForDeletion: vi.fn(),
      rootScope: {dispatchEvent},
      finalizePendingMessageCallbacks: vi.fn(),
      adoptStreamedMessageDraft: vi.fn()
    });

    manager.onUpdateMessageId({random_id: randomId, id: serverId});
    if(echoBeforeRegistration) {
      storedMessages.set(serverId, serverMessage);
      history.unshift(serverId);
    }

    manager.beforeMessageSending(tempMessage, {processAfter: (callback: () => void) => callback()});
    if(!echoBeforeRegistration) {
      storedMessages.set(serverId, serverMessage);
      history.unshift(serverId);
    }
    manager.checkPendingMessage(serverMessage);

    expect(history).toEqual([serverId]);
    expect(manager.pendingTopMsgs[peerId]).toBeUndefined();
    expect(manager.pendingByRandomId[randomId]).toBeUndefined();
    expect(dispatchEvent).toHaveBeenCalledWith('history_update', expect.objectContaining({
      storageKey: '777_history',
      message: serverMessage,
      tempId
    }));
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
