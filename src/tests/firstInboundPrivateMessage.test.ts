import {createTestClient} from './api/harness';
import type {Message} from '@layer';
import MTProtoMessagePort from '@lib/mainWorker/mainMessagePort';

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
    const port = MTProtoMessagePort.getInstance<false>();

    vi.spyOn(messages.apiUpdatesManager, 'isInitialSync').mockReturnValue(isInitialSync);
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

    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();

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

    await vi.waitFor(() => expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeDefined());
    const dialog = client.managers.dialogsStorage.getDialogOnly(peerId);
    expect(dialog).toBeDefined();
    await vi.waitFor(() => {
      expect(client.managers.dialogsStorage.getFolderDialogs(0, false).map((item) => item.peerId)).toContain(peerId);
    });
    expect(dialog?.top_message).not.toBe(0);
    expect((messages.getMessageByPeer(peerId, dialog!.top_message) as Message.message).message).toBe('Hello from Alice');
    expect(dialog?.unread_count).toBe(1);
    await vi.waitFor(() => expect(routeNotification).toHaveBeenCalledTimes(1));
    await routeNotification.mock.results[0].value;
    expect(routeNotification.mock.calls[0][2]).toBe(isInitialSync);
    expect(invokeVoid.mock.calls.filter(([type]) => type === 'notificationBuild')).toHaveLength(notificationCount);
  });
});
