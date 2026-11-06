import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import {captureChatPageSnapshotEpoch, chatPageSnapshotGeneration, clearChatPageSnapshot, disableChatPageSnapshots, enableChatPageSnapshots, forgetLoadedChatPageSnapshot, getChatPageKey, loadChatPageSnapshot, readChatPageSnapshot, writeChatPageSnapshot} from '@lib/chatPageSnapshot';
import AccountController from '@lib/accounts/accountController';
import DialogsStorage from '@lib/storages/dialogs';
import loadStorages from '@appManagers/utils/storages/loadStorages';
import {ApiManager} from '@appManagers/apiManager';
import * as snapshotStorage from '@lib/chatPageSnapshotStorage';
import sessionStorage from '@lib/sessionStorage';

const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server-a', authKeyId: 'abc'};
const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Hello', date: 10, unread: 2, markedUnread: false, muted: false, pinned: true}];

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
    const dialog = {_: 'dialog', peerId: 42, top_message: 3, pFlags: {pinned: true}, topMessage: {_: 'message', message: 'Hello', date: 10}};
    const page = {dialogs: [dialog], count: 1, isTopEnd: true, isEnd: true};
    const storage = Object.create(DialogsStorage.prototype) as any;
    Object.assign(storage, {
      getAccountNumber: () => 1,
      snapshotEpoch: Promise.resolve(epoch),
      getDialogsInner: () => kind === 'cached' ? page : Promise.resolve(page),
      appPeersManager: {getPeer: () => ({_: 'user', first_name: 'Alice'}), getPeerPhoto: (): undefined => undefined},
      appMessagesManager: {getDialogUnreadCount: () => 2},
      appNotificationsManager: {isPeerLocalMuted: () => false},
      log: {error: (message: string, error: unknown) => { throw error; }}
    });
    await storage.getDialogs({filterId: 0, offsetIndex: 0, snapshot: true});
    await vi.waitFor(async() => {
      await loadChatPageSnapshot(accountKey);
      expect(readChatPageSnapshot(accountKey)).toEqual(rows);
    });
  });
});
