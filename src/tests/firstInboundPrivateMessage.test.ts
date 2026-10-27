import {createTestClient} from './api/harness';
import type {Message} from '@layer';
import MTProtoMessagePort from '@lib/mainWorker/mainMessagePort';
import {FOLDER_ID_ALL, FOLDER_ID_ARCHIVE} from '@lib/appManagers/constants';

describe('first inbound private messages', () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async() => {
    client = await createTestClient({
      seed: {userId: 990100, dcId: 2, authKeys: {}},
      testDc: true
    });
  }, 60_000);

  afterAll(() => {
    client?.dispose();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    {caseName: 'live update', senderId: 990101, isInitialSync: false, notificationCount: 1},
    {caseName: 'active-tab initial sync', senderId: 990102, isInitialSync: true, notificationCount: 0}
  ])('creates a dialog and preserves notification routing for $caseName', async({senderId, isInitialSync, notificationCount}) => {
    const userId = senderId as UserId;
    const peerId = userId.toPeerId();
    const messages: any = client.managers.appMessagesManager;
    const users: any = client.managers.appUsersManager;
    const notifications: any = client.managers.appNotificationsManager;
    const peers: any = client.managers.appPeersManager;
    const apiManager: any = messages.apiManager;
    const port = MTProtoMessagePort.getInstance<false>();
    const originalInvoke = apiManager.invokeApi;
    let currentInitialSync = isInitialSync;
    let resolvePeerDialogs: ((result: any) => void) | undefined;

    vi.spyOn(messages.apiUpdatesManager, 'isInitialSync').mockImplementation(() => currentInitialSync);
    vi.spyOn(messages, 'getNotifyPeerSettings').mockResolvedValue({
      muted: false,
      peerTypeNotifySettings: {show_previews: false}
    });
    vi.spyOn(peers, 'isPeerRestricted').mockResolvedValue(false);
    vi.spyOn(notifications, 'getNotificationTab').mockResolvedValue({
      state: {idleStartTime: 0},
      source: undefined
    });
    const routeNotification = vi.spyOn(notifications, 'routeNotification');
    const invokeVoid = vi.spyOn(port, 'invokeVoid').mockImplementation(() => undefined);

    apiManager.invokeApi = (method: string, ...args: any[]) => {
      if(method !== 'messages.getPeerDialogs') {
        return originalInvoke.apply(apiManager, [method, ...args]);
      }

      return new Promise((resolve) => {
        resolvePeerDialogs = resolve;
      });
    };

    users.saveApiUsers([{
      _: 'user',
      id: userId,
      access_hash: '1',
      first_name: 'Alice',
      pFlags: {}
    }]);

    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();

    try {
      messages.onUpdateNewMessage({
        _: 'updateNewMessage',
        message: {
          _: 'message',
          id: 1,
          peer_id: {_: 'peerUser', user_id: userId},
          from_id: {_: 'peerUser', user_id: userId},
          date: 1,
          message: 'Hello from Alice',
          pFlags: {unread: true}
        }
      } as any);

      await vi.waitFor(() => expect(resolvePeerDialogs).toBeTypeOf('function'));
      currentInitialSync = !isInitialSync;
      if(!resolvePeerDialogs) {
        throw new Error('messages.getPeerDialogs was not requested');
      }
      resolvePeerDialogs({
        _: 'messages.peerDialogs',
        dialogs: [],
        messages: [],
        users: [],
        chats: [],
        state: {_: 'updates.state', date: 0, pts: 0, qts: 0, seq: 0, unread_count: 0}
      });

      await vi.waitFor(() => expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeDefined());
      const dialog = client.managers.dialogsStorage.getDialogOnly(peerId);
      expect(dialog).toBeDefined();
      expect(dialog?.folder_id).toBe(FOLDER_ID_ALL);
      await vi.waitFor(() => {
        expect(client.managers.dialogsStorage.getFolderDialogs(FOLDER_ID_ALL, false).map((item) => item.peerId)).toContain(peerId);
      });
      expect(dialog?.top_message).not.toBe(0);
      expect((messages.getMessageByPeer(peerId, dialog!.top_message) as Message.message).message).toBe('Hello from Alice');
      expect(dialog?.unread_count).toBe(1);
      await vi.waitFor(() => expect(routeNotification).toHaveBeenCalledTimes(1));
      await routeNotification.mock.results[0].value;
      expect(routeNotification.mock.calls[0][2]).toBe(isInitialSync);
      expect(invokeVoid.mock.calls.filter(([type]) => type === 'notificationBuild')).toHaveLength(notificationCount);
    } finally {
      apiManager.invokeApi = originalInvoke;
    }
  });

  test('reloads an archived server dialog before applying an inbound message when it is not loaded locally', async() => {
    const userId = 990103 as UserId;
    const peerId = userId.toPeerId();
    const messages: any = client.managers.appMessagesManager;
    const users: any = client.managers.appUsersManager;
    const peers: any = client.managers.appPeersManager;
    const notifications: any = client.managers.appNotificationsManager;
    const apiManager: any = messages.apiManager;
    const port = MTProtoMessagePort.getInstance<false>();
    const originalInvoke = apiManager.invokeApi;
    const peer = {_: 'peerUser', user_id: userId};
    let peerDialogsRequestCount = 0;

    client.managers.dialogsStorage.setDialogsLoaded(FOLDER_ID_ARCHIVE, false);

    vi.spyOn(messages.apiUpdatesManager, 'isInitialSync').mockReturnValue(true);
    vi.spyOn(messages, 'getNotifyPeerSettings').mockResolvedValue({
      muted: false,
      peerTypeNotifySettings: {show_previews: false}
    });
    vi.spyOn(peers, 'isPeerRestricted').mockResolvedValue(false);
    vi.spyOn(notifications, 'getNotificationTab').mockResolvedValue({
      state: {idleStartTime: 0},
      source: undefined
    });
    const routeNotification = vi.spyOn(notifications, 'routeNotification');
    const invokeVoid = vi.spyOn(port, 'invokeVoid').mockImplementation(() => undefined);

    users.saveApiUsers([{
      _: 'user',
      id: userId,
      access_hash: '1',
      first_name: 'Alice',
      pFlags: {}
    }]);

    apiManager.invokeApi = (method: string, ...args: any[]) => {
      if(method !== 'messages.getPeerDialogs') {
        return originalInvoke.apply(apiManager, [method, ...args]);
      }

      ++peerDialogsRequestCount;
      return Promise.resolve({
        _: 'messages.peerDialogs',
        dialogs: [{
          _: 'dialog',
          peer,
          top_message: 9,
          read_inbox_max_id: 8,
          read_outbox_max_id: 7,
          unread_count: 4,
          unread_mentions_count: 2,
          unread_reactions_count: 3,
          unread_poll_votes_count: 1,
          folder_id: FOLDER_ID_ARCHIVE,
          notify_settings: {_: 'peerNotifySettings', mute_until: 2_000_000_000, show_previews: false},
          pFlags: {pinned: true}
        }],
        messages: [{
          _: 'message',
          id: 9,
          peer_id: peer,
          from_id: peer,
          date: 1,
          message: 'Older message',
          pFlags: {}
        }],
        users: [],
        chats: [],
        state: {_: 'updates.state', date: 0, pts: 0, qts: 0, seq: 0, unread_count: 0}
      });
    };

    try {
      expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();

      messages.onUpdateNewMessage({
        _: 'updateNewMessage',
        message: {
          _: 'message',
          id: 10,
          peer_id: peer,
          from_id: peer,
          date: 2,
          message: 'New inbound message',
          pFlags: {unread: true}
        }
      } as any);

      await vi.waitFor(() => expect(peerDialogsRequestCount).toBeGreaterThan(0));
      await vi.waitFor(() => {
        expect(client.managers.dialogsStorage.getDialogOnly(peerId)?.top_message).toBe(10);
      });

      const dialog = client.managers.dialogsStorage.getDialogOnly(peerId);
      expect(dialog).toMatchObject({
        peerId,
        folder_id: FOLDER_ID_ARCHIVE,
        pFlags: {pinned: true},
        read_inbox_max_id: 8,
        read_outbox_max_id: 7,
        unread_count: 5,
        unread_mentions_count: 2,
        unread_reactions_count: 3,
        unread_poll_votes_count: 1,
        notify_settings: {mute_until: 2_000_000_000, show_previews: false}
      });
      expect(client.managers.dialogsStorage.getFolderDialogs(FOLDER_ID_ARCHIVE, false).map((item) => item.peerId)).toContain(peerId);
      expect(client.managers.dialogsStorage.getFolderDialogs(FOLDER_ID_ALL, false).map((item) => item.peerId)).not.toContain(peerId);
      expect((messages.getMessageByPeer(peerId, dialog!.top_message) as Message.message).message).toBe('New inbound message');
      await vi.waitFor(() => expect(routeNotification).toHaveBeenCalledTimes(1));
      await routeNotification.mock.results[0].value;
      expect(invokeVoid.mock.calls.filter(([type]) => type === 'notificationBuild')).toHaveLength(0);
    } finally {
      apiManager.invokeApi = originalInvoke;
    }
  });
});
