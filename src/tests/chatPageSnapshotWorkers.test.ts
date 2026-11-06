import {expect, it, vi} from 'vitest';
import {getCommonDatabaseState} from '@config/databases/state';
import IDBStorage from '@lib/files/idb';

it('writes the first page after this worker completes its own storage reset', async() => {
  vi.resetModules();
  const snapshots = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const {AppStoragesManager} = await import('@appManagers/appStoragesManager');
  const DialogsStorage = (await import('@lib/storages/dialogs')).default;
  const sessionStorage = (await import('@lib/sessionStorage')).default;
  vi.spyOn(sessionStorage, 'getFresh').mockResolvedValue({userId: 123 as PeerId, dcId: 2, dc2_auth_key: '12'.repeat(256)});
  const key = await snapshots.getChatPageKey(1);
  const reset = Promise.resolve({storages: new Map([['dialogs', []]]), callback: async() => {}});
  const manager = new AppStoragesManager(1, reset as any) as any;
  const store = {getAll: async(): Promise<unknown[]> => [], clear: async() => {}, get: async(): Promise<undefined> => undefined, set: async() => {}};
  manager.storages = {users: store, chats: store, dialogs: store};
  await manager.loadStorages();
  const page = {dialogs: [{_: 'dialog', peerId: 42, top_message: 3, pFlags: {pinned: true}, topMessage: {_: 'message', message: 'Hello', date: 10}}]};
  const storage = Object.assign(Object.create(DialogsStorage.prototype), {
    getAccountNumber: () => 1,
    appPeersManager: {getPeer: () => ({_: 'user', first_name: 'Alice'}), getPeerPhoto: (): undefined => undefined},
    appMessagesManager: {getDialogUnreadCount: () => 2},
    appNotificationsManager: {isPeerLocalMuted: () => false}
  });
  await storage.refreshFirstChatPage(page, key, await manager.snapshotEpoch, key);
  await snapshots.loadChatPageSnapshot(key);
  expect(snapshots.readChatPageSnapshot(key)).toMatchObject([{peerId: 42, preview: 'Hello'}]);
  vi.restoreAllMocks();
});

it.each(['before', 'during', 'after'] as const)('fences a local reset when another worker resets %s it', async(phase) => {
  vi.resetModules();
  const first = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const {AppStoragesManager} = await import('@appManagers/appStoragesManager');
  vi.resetModules();
  const second = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  let signalStarted: () => void;
  let release: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const store = {
    getAll: async(): Promise<unknown[]> => { if(phase === 'before') { signalStarted(); await barrier; } return []; },
    clear: async() => {}, get: async(): Promise<undefined> => undefined, set: async() => {}
  };
  const reset = Promise.resolve({storages: new Map([['dialogs', []]]), callback: async() => {
    if(phase === 'during') { signalStarted(); await barrier; }
  }});
  const manager = new AppStoragesManager(1, reset as any) as any;
  manager.storages = {users: store, chats: store, dialogs: store};
  const loading = manager.loadStorages();
  if(phase === 'after') await loading;
  else await started;
  const token = await second.beginChatPageSnapshotInvalidation(1);
  await second.finishChatPageSnapshotInvalidation(1, token);
  if(phase !== 'after') { release(); await loading; }
  const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server', authKeyId: 'key'};
  const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Private', date: 1, unread: 0, markedUnread: false, muted: false, pinned: false}];
  await first.writeChatPageSnapshot(key, rows, await manager.snapshotEpoch);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
});

it('binds the snapshot epoch before loading dialogs when another worker resets them', async() => {
  vi.resetModules();
  const first = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const {AppStoragesManager} = await import('@appManagers/appStoragesManager');
  const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server', authKeyId: 'key'};
  const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Private', date: 1, unread: 0, markedUnread: false, muted: false, pinned: false}];
  const noReset = Promise.resolve({storages: new Map(), callback: async() => {}});
  const manager = new AppStoragesManager(1, noReset as any) as any;
  const store = {getAll: async() => rows.slice(), clear: async() => {}, get: async(): Promise<undefined> => undefined, set: async() => {}};
  manager.storages = {users: store, chats: store, dialogs: store};
  await manager.loadStorages();
  const boundEpoch = await manager.snapshotEpoch;
  expect(boundEpoch).toBeTruthy();

  vi.resetModules();
  const second = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const loadStorages = (await import('@appManagers/utils/storages/loadStorages')).default;
  const reset = Promise.resolve({storages: new Map([['dialogs', []]]), callback: async() => {}});
  await loadStorages(1, {users: store, chats: store, dialogs: store} as any, reset as any);
  await first.writeChatPageSnapshot(key, rows, boundEpoch);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();

  const freshManager = new AppStoragesManager(1, noReset as any) as any;
  freshManager.storages = {users: store, chats: store, dialogs: store};
  await freshManager.loadStorages();
  const freshEpoch = await freshManager.snapshotEpoch;
  expect(freshEpoch).not.toBe(boundEpoch);
  await first.writeChatPageSnapshot(key, rows, freshEpoch);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toEqual(rows);
});

it('keeps startup blocked when invalidation is already in progress', async() => {
  vi.resetModules();
  const snapshots = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  const {AppStoragesManager} = await import('@appManagers/appStoragesManager');
  const token = await snapshots.beginChatPageSnapshotInvalidation(1);
  const reset = Promise.resolve({storages: new Map(), callback: async() => {}});
  const manager = new AppStoragesManager(1, reset as any) as any;
  const store = {getAll: async(): Promise<unknown[]> => []};
  manager.storages = {users: store, chats: store, dialogs: store};
  await manager.loadStorages();
  await snapshots.finishChatPageSnapshotInvalidation(1, token);
  expect(await manager.snapshotEpoch).toBeUndefined();
});

it('recovers an abandoned passcode block at boot under the cross-tab lock', async() => {
  vi.resetModules();
  const snapshots = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  vi.stubGlobal('navigator', {locks: {request: async(_name: string, callback: () => Promise<unknown>) => callback()}});
  try {
    const guard = snapshots.blockSnapshotReads();
    await snapshots.disableChatPageSnapshots(guard);
    expect(await snapshots.captureChatPageSnapshotEpoch(1)).toBeUndefined();
    await snapshots.recoverPasscodeSnapshots();
    expect(await snapshots.captureChatPageSnapshotEpoch(1)).toBeTruthy();
    expect(Object.keys(localStorage).some((key) => key.includes('snapshot-open-guard') && localStorage.getItem(key) === guard)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('does not recover a block while passcode metadata is present', async() => {
  vi.resetModules();
  const snapshots = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  vi.stubGlobal('navigator', {locks: {request: async(_name: string, callback: () => Promise<unknown>) => callback()}});
  const store = new IDBStorage(getCommonDatabaseState(), 'session');
  const guard = snapshots.blockSnapshotReads();
  try {
    await snapshots.disableChatPageSnapshots(guard);
    await store.save('passcode', {verificationHash: new Uint8Array([1])});
    await expect(snapshots.recoverPasscodeSnapshots()).rejects.toBeDefined();
    expect(await snapshots.captureChatPageSnapshotEpoch(1)).toBeUndefined();
  } finally {
    await store.delete('passcode');
    await snapshots.enableChatPageSnapshots(guard);
    snapshots.unblockSnapshotReads(guard);
    vi.unstubAllGlobals();
  }
});

it('does not recover a block while another tab is enabling a passcode', async() => {
  vi.resetModules();
  const snapshots = await import('@lib/chatPageSnapshot');
  (await import('@lib/passcode/deferredIsUsingPasscode')).default.resolveDeferred(false);
  let queue = Promise.resolve();
  vi.stubGlobal('navigator', {locks: {request: (_name: string, callback: () => Promise<unknown>) => {
    const result = queue.then(callback);
    queue = result.then(() => {}, () => {});
    return result;
  }}});
  const store = new IDBStorage(getCommonDatabaseState(), 'session');
  let release: () => void;
  let signalStarted: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let guard: string;
  try {
    const activation = snapshots.withPasscodeSnapshotLock(async() => {
      guard = snapshots.blockSnapshotReads();
      await snapshots.disableChatPageSnapshots(guard);
      signalStarted();
      await barrier;
      await store.save('passcode', {verificationHash: new Uint8Array([1])});
    });
    await started;
    const recovery = snapshots.recoverPasscodeSnapshots();
    release();
    await activation;
    await expect(recovery).rejects.toBeDefined();
    expect(await snapshots.captureChatPageSnapshotEpoch(1)).toBeUndefined();
  } finally {
    await store.delete('passcode');
    await snapshots.enableChatPageSnapshots(guard);
    snapshots.unblockSnapshotReads(guard);
    vi.unstubAllGlobals();
  }
});

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
  const cleared = await first.beginChatPageSnapshotInvalidation(1);
  await first.finishChatPageSnapshotInvalidation(1, cleared);
  const epoch = await first.captureChatPageSnapshotEpoch(1);
  await first.writeChatPageSnapshot(key, rows, epoch);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toEqual(rows);
  const guard = second.blockSnapshotReads();
  await second.disableChatPageSnapshots(guard);
  expect(await first.captureChatPageSnapshotEpoch(1)).toBeUndefined();
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
  await first.writeChatPageSnapshot(key, rows, epoch);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
  await second.enableChatPageSnapshots(guard);
  second.unblockSnapshotReads(guard);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
  await first.writeChatPageSnapshot(key, rows, epoch);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toBeUndefined();
  const freshEpoch = await first.captureChatPageSnapshotEpoch(1);
  expect(freshEpoch).not.toBe(epoch);
  await first.writeChatPageSnapshot(key, rows, freshEpoch);
  await first.loadChatPageSnapshot(key);
  expect(first.readChatPageSnapshot(key)).toEqual(rows);

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
  const cleared = await first.beginChatPageSnapshotInvalidation(1);
  await first.finishChatPageSnapshotInvalidation(1, cleared);
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
