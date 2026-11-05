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

test('coalesces reconciliation chat updates into one mirror batch per server page', async() => {
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
  const saveApiPeers = vi.fn((result: any, _trace: unknown, mirrorBatch: any, options: any) => {
    result.chats.forEach((chat: any) => {
      mirrorBatch('' + chat.id, chat);
      options?.chatUpdateIds?.add(chat.id);
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
    appChatsManager: {isInChat: vi.fn()},
    cachedListReconciled: false,
    getDialogOnly: () => ({})
  });

  await storage.getServerChannelsMissingLocally();

  const pageBatches = mirrorApiPeers.mock.calls.filter((call) => call.length === 5);
  expect(pageBatches.map((call) => [...call[4] as Set<number>])).toEqual([[42], [43]]);
});
