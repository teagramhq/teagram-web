import {afterEach, expect, test, vi} from 'vitest';
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

test('batches reconciled chat and user mirrors into one merge payload', () => {
  vi.stubEnv('VITE_PERF_TRACE', '1');
  const invokeVoid = vi.fn();
  vi.spyOn(MTProtoMessagePort, 'getInstance').mockReturnValue({invokeVoid} as any);

  const chat = {_: 'channel', id: 42} as any;
  const user = {_: 'user', id: 7} as any;
  const manager = Object.create(AppPeersManager.prototype) as any;
  Object.assign(manager, {
    appChatsManager: {
      saveApiChats: vi.fn((_chats, _override, _trace, mirrorBatch) => mirrorBatch?.('chat-key', chat))
    },
    appUsersManager: {
      saveApiUsers: vi.fn((_users, _override, _trace, mirrorBatch) => mirrorBatch?.('user-key', user))
    },
    getAccountNumber: () => 1
  });

  manager.saveApiPeers({chats: [chat], users: [user]}, 'cachedChannelDialogsReconcile', true);

  expect(manager.appChatsManager.saveApiChats).toHaveBeenCalledWith(
    [chat],
    undefined,
    'cachedChannelDialogsReconcile',
    expect.any(Function)
  );
  expect(manager.appUsersManager.saveApiUsers).toHaveBeenCalledWith(
    [user],
    undefined,
    'cachedChannelDialogsReconcile',
    expect.any(Function)
  );
  expect(invokeVoid).toHaveBeenCalledTimes(1);
  expect(invokeVoid).toHaveBeenCalledWith('mirror', {
    name: 'peers',
    value: {'chat-key': chat, 'user-key': user},
    merge: true,
    accountNumber: 1,
    trace: 'cachedChannelDialogsReconcile'
  });
});
