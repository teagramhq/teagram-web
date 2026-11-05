import {expect, test, vi} from 'vitest';
import type DialogsStorage from '@lib/storages/dialogs';

test('reloads missing cached dialogs in bounded worker batches', async() => {
  const peerIds = Array.from({length: 60}, (_, index) => -(index + 1) as PeerId);
  let activeReloads = 0;
  let maxActiveReloads = 0;
  const reloadConversation = vi.fn(async() => {
    ++activeReloads;
    maxActiveReloads = Math.max(maxActiveReloads, activeReloads);
    await Promise.resolve();
    --activeReloads;
  });
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    appMessagesManager: {reloadConversation},
    appChatsManager: {isInChat: () => false},
    cachedListReconciled: false,
    getDialogOnly: (): undefined => undefined,
    getServerChannelsMissingLocally: async() => peerIds
  });

  await storage.reconcileCachedChannelDialogs();

  expect(reloadConversation).toHaveBeenCalledTimes(peerIds.length);
  expect(maxActiveReloads).toBeLessThanOrEqual(25);
});

test('mirrors each reconciliation page before delivering its peer events', async() => {
  const pages: any[] = [
    {
      _: 'messages.dialogsSlice',
      count: 2,
      dialogs: [{_: 'dialog', peer: {_: 'peerChannel', id: 42}, top_message: 100}],
      messages: [],
      chats: [{_: 'channel', id: 42}]
    },
    {
      _: 'messages.dialogsSlice',
      count: 2,
      dialogs: [{_: 'dialog', peer: {_: 'peerChannel', id: 43}, top_message: 200}],
      messages: [],
      chats: [{_: 'channel', id: 43}]
    }
  ];
  const mirrorApiPeers = vi.fn();
  let capturedEvents: any[];
  const saveApiPeers = vi.fn((result: any, _trace: unknown, mirrorBatch: any) => {
    result.chats.forEach((chat: any) => {
      mirrorBatch('' + chat.id, chat);
      capturedEvents.push({name: 'chat_update', args: [chat.id]});
      capturedEvents.push({name: 'user_update', args: [chat.id + 100]});
    });
  });
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    apiManager: {
      invokeApiSingleProcess: vi.fn(async({processResult}: any) => {
        const result = pages.shift();
        processResult(result);
        return result;
      })
    },
    appPeersManager: {
      getPeerId: ({id}: {id: number}) => id,
      getInputPeerById: () => ({_: 'inputPeerEmpty'}),
      saveApiPeers,
      mirrorApiPeers
    },
    rootScope: {collectBroadcastEvents: (events: any[], callback: () => void) => {
      capturedEvents = events;
      callback();
    }},
    appChatsManager: {isInChat: vi.fn()},
    cachedListReconciled: false,
    getDialogOnly: () => ({})
  });

  await storage.getServerChannelsMissingLocally();

  const calls = mirrorApiPeers.mock.calls;
  expect(calls[0][0]).toEqual(['42']);
  expect(calls[0][6]).toEqual([42]);
  expect(calls[1][5]).toEqual([{name: 'chat_update', args: [42]}, {name: 'user_update', args: [142, {statusFromWorker: true}]}]);
  expect(calls[2][0]).toEqual(['43']);
  expect(calls[3][5]).toEqual([{name: 'chat_update', args: [43]}, {name: 'user_update', args: [143, {statusFromWorker: true}]}]);
});

test('splits large pages into bounded mirror and notification tasks', async() => {
  const chats = Array.from({length: 25}, (_, index) => ({_: 'channel', id: index + 1}));
  const page: any = {_: 'messages.dialogs', chats, dialogs: [], messages: []};
  let capturedEvents: any[];
  const mirrorApiPeers = vi.fn();
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    rootScope: {collectBroadcastEvents: (events: any[], callback: () => void) => {
      capturedEvents = events;
      callback();
    }},
    apiManager: {invokeApiSingleProcess: async({processResult}: any) => processResult(page)},
    appPeersManager: {
      saveApiPeers: (result: any, _trace: unknown, mirrorBatch: any) => result.chats.forEach((chat: any) => {
        mirrorBatch(String(chat.id), chat);
        capturedEvents.push({name: 'chat_update', args: [chat.id]});
      }),
      mirrorApiPeers
    },
    appChatsManager: {isInChat: vi.fn()},
    getDialogOnly: () => ({})
  });

  await storage.getServerChannelsMissingLocally();

  const calls = mirrorApiPeers.mock.calls;
  expect(calls.slice(0, 3).map((call) => call[0].length)).toEqual([10, 10, 5]);
  expect(calls.slice(3, 6).map((call) => call[5].length)).toEqual([10, 10, 5]);
  expect(calls.slice(3, 6).flatMap((call) => call[5].map((event: any) => event.args[0]))).toEqual(chats.map((chat) => chat.id));
});

test('marks captured user updates for synchronous status reads', async() => {
  const page: any = {_: 'messages.dialogs', users: [{_: 'user', id: 7}], dialogs: [], messages: []};
  let capturedEvents: any[];
  const mirrorApiPeers = vi.fn();
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    rootScope: {collectBroadcastEvents: (events: any[], callback: () => void) => {
      capturedEvents = events;
      callback();
    }},
    apiManager: {invokeApiSingleProcess: async({processResult}: any) => processResult(page)},
    appPeersManager: {
      saveApiPeers: (result: any, _trace: unknown, mirrorBatch: any) => {
        mirrorBatch('7', result.users[0]);
        capturedEvents.push({name: 'user_update', args: [7]}, {name: 'user_update', args: [8]});
      },
      mirrorApiPeers
    },
    appChatsManager: {isInChat: vi.fn()},
    getDialogOnly: () => ({})
  });

  await storage.getServerChannelsMissingLocally();

  expect(mirrorApiPeers.mock.calls[1][5]).toEqual([
    {name: 'user_update', args: [7, {statusFromWorker: true}]},
    {name: 'user_update', args: [8, {statusFromWorker: true}]}
  ]);
});
