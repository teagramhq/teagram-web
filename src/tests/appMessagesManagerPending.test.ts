import {describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {AppMessagesManager} from '@appManagers/appMessagesManager';

describe('AppMessagesManager pending message reconciliation', () => {
  it.each([
    {echoBeforeRegistration: false, echoBeforeAcknowledgement: false, echoOrder: 'after pending registration'},
    {echoBeforeRegistration: true, echoBeforeAcknowledgement: false, echoOrder: 'before acknowledgement'},
    {echoBeforeRegistration: true, echoBeforeAcknowledgement: true, echoOrder: 'before acknowledgement and pending registration'}
  ])('reconciles an early ID acknowledgement when the server echo arrives $echoOrder', ({echoBeforeRegistration, echoBeforeAcknowledgement}) => {
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
    const debugLog = vi.fn();

    Object.assign(manager, {
      log: {bindPrefix: () => ({debug: debugLog})},
      pendingByRandomId: {},
      pendingByMessageId: {},
      pendingMessageIdsByRandomId: {},
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

    const storeServerEcho = () => {
      storedMessages.set(serverId, serverMessage);
      history.unshift(serverId);
    };
    if(echoBeforeRegistration && echoBeforeAcknowledgement) {
      storeServerEcho();
    }
    manager.onUpdateMessageId({random_id: randomId, id: serverId});
    if(echoBeforeRegistration && !echoBeforeAcknowledgement) storeServerEcho();

    manager.beforeMessageSending(tempMessage, {processAfter: (callback: () => void) => callback()});
    if(!echoBeforeRegistration) {
      storeServerEcho();
      manager.checkPendingMessage(serverMessage);
    }

    expect(history).toEqual([serverId]);
    expect(manager.pendingTopMsgs[peerId]).toBeUndefined();
    expect(manager.pendingByRandomId[randomId]).toBeUndefined();
    expect(manager.pendingByMessageId[serverId]).toBeUndefined();
    expect(manager.pendingMessageIdsByRandomId[randomId]).toBeUndefined();
    expect(debugLog).toHaveBeenCalledWith('buffering unmatched updateMessageID', randomId, serverId);
    expect(dispatchEvent).toHaveBeenCalledWith('history_update', expect.objectContaining({
      storageKey: '777_history',
      message: serverMessage,
      tempId
    }));
  });

  it('clears a buffered ID acknowledgement when its pending message is finalized', () => {
    const manager = new AppMessagesManager() as any;
    const randomId = '42';
    const tempId = 3.0001;
    const serverId = 4;
    const pendingData = {peerId: 777 as PeerId, tempId, storage: {key: '777_history'}};
    const tempMessage = {mid: tempId, _: 'message', pFlags: {is_outgoing: true}};
    const serverMessage = {mid: serverId, peerId: 777 as PeerId, _: 'message', pFlags: {is_outgoing: true}};

    Object.assign(manager, {
      pendingByRandomId: {[randomId]: pendingData},
      pendingMessageIdsByRandomId: {[randomId]: serverId},
      getHistoryStorage: () => ({history: {delete: vi.fn()}}),
      getMessageFromStorage: (_storage: unknown, mid: number) => mid === tempId ? tempMessage : undefined,
      updateMessageContextForDeletion: vi.fn(),
      getDialogOnly: (): undefined => undefined,
      rootScope: {dispatchEvent: vi.fn()},
      deletePendingTopMsg: vi.fn(),
      finalizePendingMessageCallbacks: vi.fn()
    });

    manager.finalizePendingMessage(randomId, serverMessage);

    expect(manager.pendingMessageIdsByRandomId[randomId]).toBeUndefined();
  });

  it('clears a buffered ID acknowledgement when its pending message is canceled', () => {
    const manager = new AppMessagesManager() as any;
    const randomId = '42';
    Object.assign(manager, {
      pendingByRandomId: {},
      pendingMessageIdsByRandomId: {[randomId]: 4}
    });

    expect(manager.cancelPendingMessage(randomId)).toBe(false);
    expect(manager.pendingMessageIdsByRandomId[randomId]).toBeUndefined();
  });

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
      pendingMessageIdsByRandomId: {},
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
