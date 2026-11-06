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
  const epoch = await first.captureChatPageSnapshotEpoch(1);
  await first.writeChatPageSnapshot(key, rows, epoch);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toEqual(rows);
  const guard = second.blockSnapshotReads();
  await second.disableChatPageSnapshots(guard);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
  await first.writeChatPageSnapshot(key, rows, epoch);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
  await second.enableChatPageSnapshots(guard);
  second.unblockSnapshotReads(guard);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();

  const racingGuard = second.blockSnapshotReads();
  await Promise.all([
    first.writeChatPageSnapshot(key, rows, epoch),
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
  const epoch = await stale.captureChatPageSnapshotEpoch(1);
  await stale.writeChatPageSnapshot(key, rows, epoch);
  await stale.loadChatPageSnapshot(key);
  expect(stale.readChatPageSnapshot(key)).toEqual(rows);
  const oldGuard = first.blockSnapshotReads();
  await first.disableChatPageSnapshots(oldGuard);
  const newGuard = second.blockSnapshotReads();
  await second.disableChatPageSnapshots(newGuard);
  await expect(first.enableChatPageSnapshots(oldGuard)).rejects.toBeDefined();
  first.unblockSnapshotReads(oldGuard);
  expect(stale.readChatPageSnapshot(key)).toBeUndefined();
  await stale.writeChatPageSnapshot(key, rows, epoch);
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

it.each(['logout', 'reset'])('rejects an old worker write after %s invalidation', async(action) => {
  vi.resetModules();
  const first = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const loadStorages = (await import('@appManagers/utils/storages/loadStorages')).default;
  const {ApiManager} = await import('@appManagers/apiManager');
  const AccountController = (await import('@lib/accounts/accountController')).default;
  vi.resetModules();
  const stale = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server', authKeyId: 'key'};
  const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Private', date: 1, unread: 0, markedUnread: false, muted: false, pinned: false}];
  await first.clearChatPageSnapshot(1);
  const oldGeneration = stale.chatPageSnapshotGeneration(1);
  const oldEpoch = await stale.captureChatPageSnapshotEpoch(1);
  await stale.writeChatPageSnapshot(key, rows, oldEpoch, oldGeneration);
  await stale.loadChatPageSnapshot(key);
  expect(stale.readChatPageSnapshot(key)).toEqual(rows);
  let signalStarted: () => void;
  let finish: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const barrier = new Promise<void>((resolve) => { finish = resolve; });
  let operation: Promise<unknown>;
  if(action === 'logout') {
    vi.spyOn(AccountController, 'getTotalAccounts').mockResolvedValue(1);
    vi.spyOn(AccountController, 'get').mockResolvedValue({});
    const manager = Object.create(ApiManager.prototype) as any;
    Object.assign(manager, {
      accountNumber: 1,
      clearAccountLocally: async() => { signalStarted(); await barrier; }
    });
    operation = manager.logOut();
  } else {
    const store = {getAll: async(): Promise<unknown[]> => [], clear: async() => { signalStarted(); await barrier; }, get: async(): Promise<undefined> => undefined, set: async() => {}};
    const reset = Promise.resolve({storages: new Map([['dialogs', []]]), callback: async() => {}});
    operation = loadStorages(1, {users: store, chats: store, dialogs: store} as any, reset as any);
  }
  await started;
  expect(stale.readChatPageSnapshot(key)).toBeUndefined();
  expect(await stale.captureChatPageSnapshotEpoch(1)).toBeUndefined();
  await stale.writeChatPageSnapshot(key, rows, oldEpoch, oldGeneration);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
  finish();
  await operation;
  await stale.writeChatPageSnapshot(key, rows, oldEpoch, oldGeneration);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
  const freshEpoch = await first.captureChatPageSnapshotEpoch(1);
  await first.writeChatPageSnapshot(key, rows, freshEpoch);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toEqual(rows);
  vi.restoreAllMocks();
});

it('keeps an account blocked until overlapping invalidations both finish', async() => {
  vi.resetModules();
  const snapshots = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const first = await snapshots.beginChatPageSnapshotInvalidation(1);
  const second = await snapshots.beginChatPageSnapshotInvalidation(1);
  await snapshots.finishChatPageSnapshotInvalidation(1, first);
  expect(await snapshots.captureChatPageSnapshotEpoch(1)).toBeUndefined();
  await snapshots.finishChatPageSnapshotInvalidation(1, second);
  expect(await snapshots.captureChatPageSnapshotEpoch(1)).toBeTruthy();
});

it('does not revive an old worker after the common store is cleared', async() => {
  vi.resetModules();
  const snapshots = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server', authKeyId: 'key'};
  const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Private', date: 1, unread: 0, markedUnread: false, muted: false, pinned: false}];
  const oldEpoch = await snapshots.captureChatPageSnapshotEpoch(1);
  const token = await snapshots.beginChatPageSnapshotInvalidation(1);
  await new IDBStorage(getCommonDatabaseState(), 'session').clear();
  await snapshots.finishChatPageSnapshotInvalidation(1, token);
  const newEpoch = await snapshots.captureChatPageSnapshotEpoch(1);
  expect(newEpoch).not.toBe(oldEpoch);
  await snapshots.writeChatPageSnapshot(key, rows, oldEpoch);
  await snapshots.loadChatPageSnapshot(key);
  expect(snapshots.readChatPageSnapshot(key)).toBeUndefined();
});

it('invalidates later account slots during a logout shift', async() => {
  vi.resetModules();
  const snapshots = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const key = {accountNumber: 2 as const, userId: 123 as PeerId, server: 'server', authKeyId: 'key'};
  const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Private', date: 1, unread: 0, markedUnread: false, muted: false, pinned: false}];
  const oldEpoch = await snapshots.captureChatPageSnapshotEpoch(2);
  await snapshots.writeChatPageSnapshot(key, rows, oldEpoch);
  const held = await snapshots.beginChatPageSnapshotShift(1);
  await snapshots.writeChatPageSnapshot(key, rows, oldEpoch);
  await snapshots.finishChatPageSnapshotShift(held);
  await snapshots.loadChatPageSnapshot(key);
  expect(snapshots.readChatPageSnapshot(key)).toBeUndefined();
  expect(await snapshots.captureChatPageSnapshotEpoch(2)).not.toBe(oldEpoch);
});
