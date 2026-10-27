import {createTestClient} from './api/harness';
import type {Message} from '@layer';

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

  test('creates a dialog and queues a notification for an unknown sender', async() => {
    const senderId = 990101 as UserId;
    const peerId = senderId.toPeerId();
    const messages: any = client.managers.appMessagesManager;
    const users: any = client.managers.appUsersManager;
    const notified: Message.message[] = [];

    messages.getNotifyPeerSettings = () => Promise.resolve({
      muted: false,
      peerTypeNotifySettings: {show_previews: false}
    });
    messages.notifyAboutMessage = (message: Message.message) => {
      notified.push(message);
      return Promise.resolve();
    };

    users.saveApiUsers([{
      _: 'user',
      id: senderId,
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
        peer_id: {_: 'peerUser', user_id: senderId},
        from_id: {_: 'peerUser', user_id: senderId},
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
    expect(Object.keys(messages.notificationsToHandle)).toContain(String(peerId));
    expect(messages.notificationsToHandle[String(peerId)].isInitialSync).toBe(false);
    await vi.waitFor(() => expect(notified).toHaveLength(1));
    expect(notified[0].message).toBe('Hello from Alice');
  });
});
