import {expect, it, vi} from 'vitest';
import {getCommonDatabaseState} from '@config/databases/state';
import IDBStorage from '@lib/files/idb';

it('prevents an independent stale worker from writing after passcode activation', async() => {
  vi.resetModules();
  const first = await import('@lib/chatPageSnapshot');
  const firstPasscode = (await import('@lib/passcode/deferredIsUsingPasscode')).default;
  firstPasscode.resolveDeferred(false);
  vi.resetModules();
  const second = await import('@lib/chatPageSnapshot');
  const secondPasscode = (await import('@lib/passcode/deferredIsUsingPasscode')).default;
  secondPasscode.resolveDeferred(false);

  const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server', authKeyId: 'key'};
  const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Private', date: 1, unread: 0, markedUnread: false, muted: false, pinned: false}];
  await first.clearChatPageSnapshot(1);
  await first.writeChatPageSnapshot(key, rows);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toEqual(rows);
  const guard = second.blockSnapshotReads();
  await second.disableChatPageSnapshots(guard);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
  await first.writeChatPageSnapshot(key, rows);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
  await second.enableChatPageSnapshots(guard);
  second.unblockSnapshotReads(guard);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();

  const racingGuard = second.blockSnapshotReads();
  await Promise.all([
    first.writeChatPageSnapshot(key, rows),
    second.disableChatPageSnapshots(racingGuard)
  ]);
  await second.enableChatPageSnapshots(racingGuard);
  second.unblockSnapshotReads(racingGuard);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
});

it('keeps a newer passcode activation blocked when an older one finishes disabling', async() => {
  vi.resetModules();
  const first = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  vi.resetModules();
  const second = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  vi.resetModules();
  const stale = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server', authKeyId: 'key'};
  const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Private', date: 1, unread: 0, markedUnread: false, muted: false, pinned: false}];
  await stale.writeChatPageSnapshot(key, rows);
  await stale.loadChatPageSnapshot(key);
  expect(stale.readChatPageSnapshot(key)).toEqual(rows);
  const oldGuard = first.blockSnapshotReads();
  await first.disableChatPageSnapshots(oldGuard);
  const newGuard = second.blockSnapshotReads();
  await second.disableChatPageSnapshots(newGuard);
  await expect(first.enableChatPageSnapshots(oldGuard)).rejects.toBeDefined();
  first.unblockSnapshotReads(oldGuard);
  expect(stale.readChatPageSnapshot(key)).toBeUndefined();
  await stale.writeChatPageSnapshot(key, rows);
  await second.enableChatPageSnapshots(newGuard);
  second.unblockSnapshotReads(newGuard);
  await stale.loadChatPageSnapshot(key);
  expect(stale.readChatPageSnapshot(key)).toBeUndefined();
});

it('does not unblock while passcode metadata remains on disk', async() => {
  vi.resetModules();
  const snapshots = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const guard = snapshots.blockSnapshotReads();
  const storage = new IDBStorage(getCommonDatabaseState(), 'session');
  await snapshots.disableChatPageSnapshots(guard);
  await storage.save('passcode', {verificationHash: new Uint8Array([1])});
  await expect(snapshots.enableChatPageSnapshots(guard)).rejects.toBeDefined();
  await storage.delete('passcode');
  await snapshots.enableChatPageSnapshots(guard);
  snapshots.unblockSnapshotReads(guard);
});
