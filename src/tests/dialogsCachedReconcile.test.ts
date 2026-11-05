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
