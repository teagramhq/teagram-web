import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import {beginChatPageSnapshotInvalidation, beginChatPageSnapshotShift, captureChatPageSnapshotEpoch, chatPageSnapshotGeneration, clearChatPageSnapshot, disableChatPageSnapshots, enableChatPageSnapshots, finishChatPageSnapshotInvalidation, finishChatPageSnapshotShift, forgetLoadedChatPageSnapshot, getChatPageKey, getChatPageKeyFromAccount, loadChatPageSnapshot, readChatPageSnapshot, writeChatPageSnapshot} from '@lib/chatPageSnapshot';
import AccountController from '@lib/accounts/accountController';
import DialogsStorage from '@lib/storages/dialogs';
import loadStorages from '@appManagers/utils/storages/loadStorages';
import {ApiManager} from '@appManagers/apiManager';
import * as snapshotStorage from '@lib/chatPageSnapshotStorage';
import sessionStorage from '@lib/sessionStorage';

const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server-a', authKeyId: 'abc'};
const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Hello', date: 10, unread: 2, markedUnread: false, muted: false, pinned: true}];

function makePage() {
  const dialog = {_: 'dialog', peerId: 42, top_message: 3, pFlags: {pinned: true}, topMessage: {_: 'message', message: 'Hello', date: 10}};
  return {dialogs: [dialog], count: 1, isTopEnd: true, isEnd: true};
}

function makeStorage(overrides: Record<string, unknown>) {
  return Object.assign(Object.create(DialogsStorage.prototype), {
    getAccountNumber: () => 1,
    appPeersManager: {getPeer: () => ({_: 'user', first_name: 'Alice'}), getPeerPhoto: (): undefined => undefined},
    appMessagesManager: {getDialogUnreadCount: () => 2},
    appNotificationsManager: {isPeerLocalMuted: () => false},
    log: {error: (message: string, error: unknown) => { throw error; }},
    ...overrides
  }) as any;
}

describe('chat page snapshot storage', () => {
  let epoch: string;
  beforeEach(async() => {
    await enableChatPageSnapshots();
    DeferredIsUsingPasscode.resolveDeferred(false);
    await clearChatPageSnapshot(1);
    epoch = await captureChatPageSnapshotEpoch(1);
  });
  afterEach(() => vi.restoreAllMocks());

  it('persists a first page and reads it only for the same identity', async() => {
    await writeChatPageSnapshot(key, rows, epoch);
    await loadChatPageSnapshot(key);
    expect(readChatPageSnapshot(key)).toEqual(rows);
    expect(readChatPageSnapshot({...key, server: 'server-b'})).toBeUndefined();
    expect(readChatPageSnapshot({...key, userId: 456 as PeerId})).toBeUndefined();
    expect(readChatPageSnapshot({...key, accountNumber: 2})).toBeUndefined();
    expect(readChatPageSnapshot({...key, authKeyId: 'other'})).toBeUndefined();
  });

  it('keeps the state-load owner when the account key changes later', async() => {
    const captured = {userId: 123 as PeerId, dcId: 2 as const, dc2_auth_key: '12'.repeat(256)};
    vi.spyOn(sessionStorage, 'getFresh').mockResolvedValue({...captured, dc2_auth_key: '34'.repeat(256)});
    const owner = await getChatPageKeyFromAccount(1, captured);
    const current = await getChatPageKey(1);
    expect(owner.authKeyId).toBe('e92c74836736d11a');
    expect(current.authKeyId).not.toBe(owner.authKeyId);
  });

  it('drops the snapshot', async() => {
    await writeChatPageSnapshot(key, rows, epoch);
    await clearChatPageSnapshot(1);
    await loadChatPageSnapshot(key);
    expect(readChatPageSnapshot(key)).toBeUndefined();
  });

  it('neither writes nor reads when passcode is enabled', async() => {
    await writeChatPageSnapshot(key, rows, epoch);
    await loadChatPageSnapshot(key);
    DeferredIsUsingPasscode.resolveDeferred(true);
    expect(readChatPageSnapshot(key)).toBeUndefined();
    await writeChatPageSnapshot(key, rows, epoch);
    expect(readChatPageSnapshot(key)).toBeUndefined();
  });

  it('drops an existing snapshot and blocks queued writes when passcode is enabled', async() => {
    await writeChatPageSnapshot(key, rows, epoch);
    await disableChatPageSnapshots();
    await writeChatPageSnapshot(key, rows, epoch);
    await enableChatPageSnapshots();
    await loadChatPageSnapshot(key);
    expect(readChatPageSnapshot(key)).toBeUndefined();
  });

  it('does not restore a read that finishes after logout', async() => {
    let finish: (value: any) => void;
    vi.spyOn(snapshotStorage, 'readSnapshot').mockReturnValue(new Promise((resolve) => { finish = resolve; }) as any);
    const loading = loadChatPageSnapshot(key);
    await Promise.resolve();
    forgetLoadedChatPageSnapshot();
    finish({key, rows});
    await loading;
    expect(readChatPageSnapshot(key)).toBeUndefined();
  });

  it('drops the snapshot when storage reset is applied', async() => {
    await writeChatPageSnapshot(key, rows, epoch);
    const store = {getAll: async(): Promise<unknown[]> => [], clear: async() => {}, get: async(): Promise<undefined> => undefined, set: async() => {}};
    const reset = Promise.resolve({storages: new Map([['dialogs', []]]), callback: async() => {}});
    await loadStorages(1, {users: store, chats: store, dialogs: store} as any, reset as any);
    await loadChatPageSnapshot(key);
    expect(readChatPageSnapshot(key)).toBeUndefined();
  });

  it('drops the snapshot when the account logs out', async() => {
    await writeChatPageSnapshot(key, rows, epoch);
    const generation = chatPageSnapshotGeneration(1);
    vi.spyOn(AccountController, 'getTotalAccounts').mockResolvedValue(1);
    vi.spyOn(AccountController, 'get').mockResolvedValue({});
    const manager = Object.create(ApiManager.prototype) as any;
    Object.assign(manager, {accountNumber: 1, clearAccountLocally: async() => {}});
    await manager.logOut();
    await writeChatPageSnapshot(key, rows, epoch, generation);
    await loadChatPageSnapshot(key);
    expect(readChatPageSnapshot(key)).toBeUndefined();
  });

  it.each(['cached', 'fetched'])('writes the %s first page from the chat-list path', async(kind) => {
    vi.spyOn(sessionStorage, 'getFresh').mockResolvedValue({userId: 123 as PeerId, dcId: 2, dc2_auth_key: '12'.repeat(256)});
    const accountKey = await getChatPageKey(1);
    expect(accountKey).toMatchObject({accountNumber: 1, userId: 123, authKeyId: 'e92c74836736d11a'});
    const page = makePage();
    const storage = makeStorage({
      snapshotEpoch: Promise.resolve(epoch),
      snapshotOwner: Promise.resolve(accountKey),
      getDialogsInner: () => kind === 'cached' ? page : Promise.resolve(page)
    });
    await storage.getDialogs({filterId: 0, offsetIndex: 0, snapshot: true});
    await vi.waitFor(async() => {
      await loadChatPageSnapshot(accountKey);
      expect(readChatPageSnapshot(accountKey)).toEqual(rows);
    });
  });

  it.each(['old epoch', 'started while blocked'])('writes a later page after invalidation: %s', async(kind) => {
    vi.spyOn(sessionStorage, 'getFresh').mockResolvedValue({userId: 123 as PeerId, dcId: 2, dc2_auth_key: '12'.repeat(256)});
    const accountKey = await getChatPageKey(1);
    const token = await beginChatPageSnapshotInvalidation(1);
    const initialEpoch = kind === 'old epoch' ? epoch : await captureChatPageSnapshotEpoch(1);
    const page = makePage();
    const storage = makeStorage({
      snapshotEpoch: Promise.resolve(initialEpoch),
      snapshotOwner: Promise.resolve(accountKey),
      getDialogsInner: () => page
    });
    await finishChatPageSnapshotInvalidation(1, token);
    await storage.getDialogs({filterId: 0, offsetIndex: 0, snapshot: true});
    await vi.waitFor(async() => {
      await loadChatPageSnapshot(accountKey);
      expect(readChatPageSnapshot(accountKey)).toEqual(rows);
    });
  });

  it('re-reads the page after invalidation instead of storing an in-flight page', async() => {
    vi.spyOn(sessionStorage, 'getFresh').mockResolvedValue({userId: 123 as PeerId, dcId: 2, dc2_auth_key: '12'.repeat(256)});
    const accountKey = await getChatPageKey(1);
    let resolvePage: (value: any) => void;
    const oldPage = new Promise((resolve) => { resolvePage = resolve; });
    const newPage = makePage();
    const storage = makeStorage({
      snapshotEpoch: Promise.resolve(epoch),
      snapshotOwner: Promise.resolve(accountKey),
      getDialogsInner: (options: {recursion?: boolean}) => options.recursion ? newPage : oldPage
    });
    const loading = storage.getDialogs({filterId: 0, offsetIndex: 0, snapshot: true});
    const token = await beginChatPageSnapshotInvalidation(1);
    await finishChatPageSnapshotInvalidation(1, token);
    resolvePage({dialogs: [{...newPage.dialogs[0], topMessage: {_: 'message', message: 'Old', date: 1}}]});
    await loading;
    await vi.waitFor(async() => {
      await loadChatPageSnapshot(accountKey);
      expect(readChatPageSnapshot(accountKey)).toEqual(rows);
    });
  });

  it('writes a remaining account under its new slot after logout shifts accounts', async() => {
    const oldAccount = {userId: 123 as PeerId, dcId: 2, dc2_auth_key: '12'.repeat(256)};
    const replacement = {userId: 456 as PeerId, dcId: 2, dc2_auth_key: '34'.repeat(256)};
    let shifted = false;
    vi.spyOn(sessionStorage, 'getFresh').mockImplementation((async(name: string) => {
      if(name === 'account2') return shifted ? replacement : oldAccount;
      if(name === 'account1' && shifted) return oldAccount;
      return undefined;
    }) as any);
    const owner = await getChatPageKey(2);
    const oldEpoch = await captureChatPageSnapshotEpoch(2);
    const page = makePage();
    const storage = makeStorage({
      getAccountNumber: () => 2,
      snapshotEpoch: Promise.resolve(oldEpoch),
      snapshotOwner: Promise.resolve(owner),
      getDialogsInner: () => page
    });
    const held = await beginChatPageSnapshotShift(1);
    shifted = true;
    await finishChatPageSnapshotShift(held);
    await storage.getDialogs({filterId: 0, offsetIndex: 0, snapshot: true});
    const newKey = await getChatPageKey(1);
    await vi.waitFor(async() => {
      await loadChatPageSnapshot(newKey);
      expect(readChatPageSnapshot(newKey)).toEqual(rows);
    });
    await loadChatPageSnapshot(await getChatPageKey(2));
    expect(readChatPageSnapshot(await getChatPageKey(2))).toBeUndefined();
  });

  it('does not attach an old worker page to a replacement account', async() => {
    const oldAccount = {userId: 123 as PeerId, dcId: 2, dc2_auth_key: '12'.repeat(256)};
    const replacement = {userId: 456 as PeerId, dcId: 2, dc2_auth_key: '34'.repeat(256)};
    let changed = false;
    vi.spyOn(sessionStorage, 'getFresh').mockImplementation((async(name: string) => {
      return name === 'account1' ? (changed ? replacement : oldAccount) : undefined;
    }) as any);
    const owner = await getChatPageKey(1);
    changed = true;
    const replacementKey = await getChatPageKey(1);
    const storage = Object.create(DialogsStorage.prototype) as any;
    Object.assign(storage, {getAccountNumber: () => 1});
    await storage.refreshFirstChatPage({filterId: 0, snapshot: true}, {dialogs: []}, replacementKey, epoch, owner);
    await loadChatPageSnapshot(replacementKey);
    expect(readChatPageSnapshot(replacementKey)).toBeUndefined();
  });

  it('does not rebind an old page after the same user gets a new auth key', async() => {
    let authKey = '12'.repeat(256);
    vi.spyOn(sessionStorage, 'getFresh').mockImplementation((async(name: string) => {
      return name === 'account1' ? {userId: 123 as PeerId, dcId: 2, dc2_auth_key: authKey} : undefined;
    }) as any);
    const owner = await getChatPageKey(1);
    authKey = '34'.repeat(256);
    const newKey = await getChatPageKey(1);
    const storage = Object.create(DialogsStorage.prototype) as any;
    Object.assign(storage, {getAccountNumber: () => 1});
    await storage.refreshFirstChatPage({filterId: 0, snapshot: true}, {dialogs: []}, newKey, epoch, owner);
    await loadChatPageSnapshot(newKey);
    expect(readChatPageSnapshot(newKey)).toBeUndefined();
  });

  it('does not choose between multiple matching shifted slots', async() => {
    const account = {userId: 123 as PeerId, dcId: 2, dc2_auth_key: '12'.repeat(256)};
    vi.spyOn(sessionStorage, 'getFresh').mockImplementation((async(name: string) => {
      return name === 'account1' || name === 'account3' ? account : undefined;
    }) as any);
    const owner = {...await getChatPageKey(1), accountNumber: 2 as const};
    const storage = makeStorage({getAccountNumber: () => 2});
    await storage.refreshFirstChatPage({filterId: 0, snapshot: true}, makePage(), undefined, epoch, owner);
    const firstKey = await getChatPageKey(1);
    await loadChatPageSnapshot(firstKey);
    expect(readChatPageSnapshot(firstKey)).toBeUndefined();
  });

  it('binds a new sign-in to its first authenticated page', async() => {
    vi.spyOn(sessionStorage, 'getFresh').mockResolvedValue({userId: 123 as PeerId, dcId: 2, dc2_auth_key: '12'.repeat(256)});
    const accountKey = await getChatPageKey(1);
    const page = makePage();
    const storage = makeStorage({
      snapshotEpoch: Promise.resolve(epoch),
      snapshotOwner: Promise.resolve(undefined),
      snapshotMayBind: true,
      getDialogsInner: () => page
    });
    await storage.getDialogs({filterId: 0, offsetIndex: 0, snapshot: true});
    await vi.waitFor(async() => {
      await loadChatPageSnapshot(accountKey);
      expect(readChatPageSnapshot(accountKey)).toEqual(rows);
    });
  });
});
