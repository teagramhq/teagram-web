import {afterEach, expect, test, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import MTProtoMessagePort from '@lib/mainWorker/mainMessagePort';
import {AppChatsManager} from '@appManagers/appChatsManager';
import {AppPeersManager} from '@appManagers/appPeersManager';
import {AppUsersManager} from '@appManagers/appUsersManager';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test('chat and user managers collect their mirror values without sending individual tasks', () => {
  const invokeVoid = vi.fn();
  vi.spyOn(MTProtoMessagePort, 'getInstance').mockReturnValue({invokeVoid} as any);
  const mirrorBatch = vi.fn();
  const chat = {_: 'channel', id: {toPeerId: () => -42}} as any;
  const user = {_: 'user', id: 7} as any;
  const chatsManager = Object.create(AppChatsManager.prototype) as any;
  const usersManager = Object.create(AppUsersManager.prototype) as any;

  chatsManager.mirrorChat(chat, undefined, mirrorBatch);
  usersManager.mirrorUser(user, undefined, mirrorBatch);

  expect(mirrorBatch).toHaveBeenNthCalledWith(1, '-42', chat);
  expect(mirrorBatch).toHaveBeenNthCalledWith(2, '7', user);
  expect(invokeVoid).not.toHaveBeenCalled();
});

test('cached dialog reconciliation skips duplicate empty-channel list reconciliation', () => {
  const chat = {_: 'channel', id: 42, title: 'same', pFlags: {}} as any;
  const dispatchEvent = vi.fn();
  const chatsManager = Object.create(AppChatsManager.prototype) as any;
  Object.assign(chatsManager, {
    chats: {'42': {...chat}},
    appUsersManager: {setUsernameToCache: vi.fn(() => false)},
    appStoriesManager: {saveApiPeerStories: vi.fn()},
    appCommunitiesManager: {handlePeerLinkedCommunityUpdate: vi.fn()},
    peersStorage: {isPeerNeeded: vi.fn(() => false)},
    rootScope: {dispatchEvent},
    mirrorChat: vi.fn()
  });

  chatsManager.saveApiChat(chat, undefined, undefined, undefined, {skipEmptyChannelDialogReconciliation: true});

  expect(dispatchEvent).toHaveBeenCalledWith('chat_update', 42, {skipEmptyChannelDialogReconciliation: true});
});

test('collects reconciliation chat updates while keeping worker-local listeners current', () => {
  const chat = {_: 'channel', id: 42, title: 'same', pFlags: {}} as any;
  const chatUpdateIds = new Set<number>();
  const dispatchEvent = vi.fn();
  const dispatchEventSingle = vi.fn();
  const chatsManager = Object.create(AppChatsManager.prototype) as any;
  Object.assign(chatsManager, {
    chats: {'42': {...chat}},
    appUsersManager: {setUsernameToCache: vi.fn(() => false)},
    appStoriesManager: {saveApiPeerStories: vi.fn()},
    appCommunitiesManager: {handlePeerLinkedCommunityUpdate: vi.fn()},
    peersStorage: {isPeerNeeded: vi.fn(() => false)},
    rootScope: {dispatchEvent, dispatchEventSingle},
    mirrorChat: vi.fn()
  });

  chatsManager.saveApiChat(chat, undefined, undefined, undefined, {
    skipEmptyChannelDialogReconciliation: true,
    chatUpdateIds
  });

  expect(chatUpdateIds).toEqual(new Set([42]));
  expect(dispatchEventSingle).toHaveBeenCalledWith('chat_update', 42, {skipEmptyChannelDialogReconciliation: true});
  expect(dispatchEvent).not.toHaveBeenCalledWith('chat_update', 42, expect.anything());
});

test('mirrors the current peers and drops chats cleared before flush', () => {
  vi.stubEnv('VITE_PERF_TRACE', '1');
  const invokeVoid = vi.fn();
  vi.spyOn(MTProtoMessagePort, 'getInstance').mockReturnValue({invokeVoid} as any);

  const chat = {_: 'channel', id: 42} as any;
  const user = {_: 'user', id: 7} as any;
  const currentUser = {_: 'user', id: 7, first_name: 'current'} as any;
  const peerKeys = new Set<string>();
  const users: Record<string, any> = {'7': user};
  const chatsManager = Object.create(AppChatsManager.prototype) as any;
  Object.assign(chatsManager, {
    chats: {'42': chat},
    peersStorage: {isPeerNeeded: () => false},
    appUsersManager: {modifyUsernamesCache: vi.fn()},
    storage: {delete: vi.fn()},
    getAccountNumber: () => 1
  });
  chatsManager.saveApiChats = vi.fn((_chats, _override, _trace, mirrorBatch) => mirrorBatch?.('-42', chat));
  const usersManager: any = {
    getUser: (userId: number) => users[String(userId)],
    saveApiUsers: vi.fn((_users, _override, _trace, mirrorBatch) => mirrorBatch?.('7', user))
  };
  const manager = Object.create(AppPeersManager.prototype) as any;
  Object.assign(manager, {
    appChatsManager: chatsManager,
    appUsersManager: usersManager,
    getAccountNumber: () => 1,
    saveApiPeers: AppPeersManager.prototype.saveApiPeers
  });
  const mirrorBatch = (peerKey: string) => {
    peerKeys.add(peerKey);
  };
  const saveOptions = {skipEmptyChannelDialogReconciliation: true};
  manager.saveApiPeers({chats: [chat]}, 'cachedChannelDialogsReconcile', mirrorBatch, saveOptions);
  manager.saveApiPeers({users: [user]}, 'cachedChannelDialogsReconcile', mirrorBatch);

  expect(chatsManager.saveApiChats).toHaveBeenCalledWith(
    [chat],
    undefined,
    'cachedChannelDialogsReconcile',
    mirrorBatch,
    saveOptions
  );
  expect(usersManager.saveApiUsers).toHaveBeenCalledWith(
    [user],
    undefined,
    'cachedChannelDialogsReconcile',
    mirrorBatch
  );
  expect(peerKeys).toEqual(new Set(['-42', '7']));

  // AppChatsManager.clear can remove the collected chat while a later page is pending.
  delete chatsManager.chats['42'];
  users['7'] = currentUser;
  expect(chatsManager.getChat(42)).toBeUndefined();
  expect(invokeVoid).not.toHaveBeenCalled();

  const reconcilePhase = {
    name: 'worker.dialogs.cachedChannelReconcile',
    traceId: 'walk-1',
    startedAtEpochMs: 1_000,
    durationMs: 60_000,
    pageCount: 50
  };
  manager.mirrorApiPeers(peerKeys, 'cachedChannelDialogsReconcile', 'walk-1', reconcilePhase);

  expect(invokeVoid).toHaveBeenCalledTimes(1);
  expect(invokeVoid).toHaveBeenCalledWith('mirror', {
    name: 'peers',
    value: {'7': currentUser},
    merge: true,
    accountNumber: 1,
    skipEmptyChannelDialogReconciliation: true,
    trace: 'cachedChannelDialogsReconcile',
    traceId: 'walk-1',
    reconcilePhase
  });
});

test('sends coalesced chat updates as a traced mirror batch', () => {
  const invokeVoid = vi.fn();
  vi.spyOn(MTProtoMessagePort, 'getInstance').mockReturnValue({invokeVoid} as any);
  const manager = Object.create(AppPeersManager.prototype) as any;
  Object.assign(manager, {
    appChatsManager: {getChat: vi.fn()},
    appUsersManager: {getUser: vi.fn()},
    getAccountNumber: () => 1
  });

  manager.mirrorApiPeers(
    [],
    'cachedChannelDialogsReconcile',
    'walk-2',
    undefined,
    new Set([42, 43])
  );

  expect(invokeVoid).toHaveBeenCalledWith('mirror', {
    name: 'peers',
    value: {},
    merge: true,
    accountNumber: 1,
    skipEmptyChannelDialogReconciliation: true,
    trace: 'cachedChannelDialogsReconcile',
    traceId: 'walk-2',
    chatUpdateIds: [42, 43]
  });
});

test('sends peer-save broadcasts in the traced mirror message', () => {
  const invokeVoid = vi.fn();
  vi.spyOn(MTProtoMessagePort, 'getInstance').mockReturnValue({invokeVoid} as any);
  const manager = Object.create(AppPeersManager.prototype) as any;
  Object.assign(manager, {
    appChatsManager: {getChat: vi.fn()},
    appUsersManager: {getUser: vi.fn(() => ({_: 'user', id: 7}))},
    getAccountNumber: () => 1
  });
  const events = [{name: 'user_update', args: [7]}, {name: 'peer_title_edit', args: [{peerId: 7}]}];

  manager.mirrorApiPeers([], 'cachedChannelDialogsReconcile', 'walk-3', undefined, undefined, events);

  expect(invokeVoid).toHaveBeenCalledWith('mirror', expect.objectContaining({
    events,
    trace: 'cachedChannelDialogsReconcile',
    traceId: 'walk-3'
  }));
});

test('drops captured updates for peers removed before their notification batch', () => {
  const invokeVoid = vi.fn();
  vi.spyOn(MTProtoMessagePort, 'getInstance').mockReturnValue({invokeVoid} as any);
  const manager = Object.create(AppPeersManager.prototype) as any;
  Object.assign(manager, {
    appChatsManager: {getChat: vi.fn(() => undefined)},
    appUsersManager: {getUser: vi.fn(() => undefined)},
    getAccountNumber: () => 1
  });

  manager.mirrorApiPeers([], 'cachedChannelDialogsReconcile', 'walk-4', undefined, undefined, [
    {name: 'chat_update', args: [42]},
    {name: 'user_update', args: [7]}
  ]);

  expect(invokeVoid).toHaveBeenCalledWith('mirror', expect.objectContaining({traceOnly: true}));
  expect(invokeVoid.mock.calls[0][1]).not.toHaveProperty('events');
});

test('attaches the current worker status when a reconciliation update is sent', () => {
  const invokeVoid = vi.fn();
  vi.spyOn(MTProtoMessagePort, 'getInstance').mockReturnValue({invokeVoid} as any);
  const status = {_: 'userStatusOnline', expires: 42};
  const getUserStatus = vi.fn(() => status);
  const manager = Object.create(AppPeersManager.prototype) as any;
  Object.assign(manager, {
    appChatsManager: {getChat: vi.fn()},
    appUsersManager: {getUser: vi.fn(() => ({_: 'user', id: 7})), getUserStatus},
    getAccountNumber: () => 1
  });

  manager.mirrorApiPeers([], 'cachedChannelDialogsReconcile', 'walk-5', undefined, undefined, [
    {name: 'user_update', args: [7, {statusFromWorker: true}]}
  ]);

  expect(getUserStatus).toHaveBeenCalledExactlyOnceWith(7);
  expect(invokeVoid).toHaveBeenCalledWith('mirror', expect.objectContaining({
    events: [{name: 'user_update', args: [7, {statusFromWorker: true, status}]}]
  }));
});
