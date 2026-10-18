import {createTestClient} from './api/harness';

describe('invited channel dialogs', () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async() => {
    client = await createTestClient({
      seed: {userId: 990000, dcId: 2, authKeys: {}},
      testDc: true
    });
  }, 60_000);

  afterAll(() => {
    client?.dispose();
  });

  function applyEmptyChannelDialog(channel: any) {
    client.managers.dialogsStorage.applyDialogs(makeEmptyChannelDialogResult(channel, 'messages.peerDialogs'));
  }

  function makeEmptyChannelDialogResult(channel: any, type: string) {
    return {
      _: type,
      dialogs: [{
        _: 'dialog',
        peer: {_: 'peerChannel', channel_id: channel.id},
        top_message: 0,
        read_inbox_max_id: 0,
        read_outbox_max_id: 0,
        unread_count: 0,
        unread_mentions_count: 0,
        unread_reactions_count: 0,
        notify_settings: {_: 'peerNotifySettings'},
        pFlags: {}
      }],
      messages: [],
      chats: [channel],
      users: [],
      state: {_: 'updates.state', date: 0, pts: 0, qts: 0, seq: 0, unread_count: 0}
    } as any;
  }

  function makeChannel(id: number, pFlags: Record<string, true> = {}) {
    return {
      _: 'channel',
      id,
      access_hash: '1',
      title: 'Invited channel',
      date: 0,
      version: 1,
      photo: {_: 'chatPhotoEmpty'},
      pFlags: {megagroup: true, ...pFlags}
    };
  }

  test('lists an empty invited channel from the messages.getDialogs response after reload', async() => {
    const channelId = 990004;
    const peerId = (channelId as ChatId).toPeerId(true);
    const appMessagesManager: any = client.managers.appMessagesManager;
    const apiManager: any = appMessagesManager.apiManager;
    const originalInvoke = apiManager.invokeApiSingleProcess;
    const response = makeEmptyChannelDialogResult(makeChannel(channelId), 'messages.dialogsSlice');
    response.count = 1;
    apiManager.invokeApiSingleProcess = ({processResult}: any) => Promise.resolve(processResult(response));

    try {
      const {dialogs, isEnd} = await client.managers.dialogsStorage.getDialogs({limit: 20, filterId: 0});

      expect(dialogs.map((dialog) => dialog.peerId)).toContain(peerId);
      expect(isEnd).toBe(true);
      expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toMatchObject({peerId, top_message: 0});
    } finally {
      apiManager.invokeApiSingleProcess = originalInvoke;
    }
  });

  test('adds an invited empty channel when a channel update reloads its dialog', async() => {
    const channelId = 990001;
    const peerId = (channelId as ChatId).toPeerId(true);
    const updates: Map<PeerId, any>[] = [];
    const onDialogsUpdate = (dialogs: Map<PeerId, any>) => updates.push(dialogs);
    client.managers.rootScope.addEventListener('dialogs_multiupdate', onDialogsUpdate);
    const appMessagesManager: any = client.managers.appMessagesManager;
    const apiManager: any = appMessagesManager.apiManager;
    const originalInvoke = apiManager.invokeApi;
    apiManager.invokeApi = (method: string) => {
      expect(method).toBe('messages.getPeerDialogs');
      return Promise.resolve(makeEmptyChannelDialogResult(makeChannel(channelId), 'messages.peerDialogs'));
    };

    try {
      client.managers.appChatsManager.saveApiChats([makeChannel(channelId)]);
      client.managers.apiUpdatesManager.processLocalUpdate({_: 'updateChannel', channel_id: channelId} as any);
      await appMessagesManager.reloadConversation(peerId);

      expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toMatchObject({
        peerId,
        top_message: 0
      });
      expect(client.managers.dialogsStorage.getFolderDialogs(0, false).map((dialog) => dialog.peerId)).toContain(peerId);
      expect(updates.some((dialogs) => dialogs.get(peerId)?.dialog?.peerId === peerId)).toBe(true);
    } finally {
      client.managers.rootScope.removeEventListener('dialogs_multiupdate', onDialogsUpdate);
      apiManager.invokeApi = originalInvoke;
    }
  });

  test.each([
    ['left channel', 990002, (id: number) => makeChannel(id, {left: true})],
    ['kicked or banned channel', 990003, (id: number) => ({
      _: 'channelForbidden',
      id,
      access_hash: '1',
      title: 'Invited channel',
      pFlags: {megagroup: true}
    })]
  ])('does not restore an empty channel after the user is %s', (_name, channelId, makeRemovedChannel) => {
    const peerId = (channelId as number).toPeerId(true);

    applyEmptyChannelDialog(makeChannel(channelId as number));
    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeDefined();

    applyEmptyChannelDialog((makeRemovedChannel as (id: number) => any)(channelId as number));

    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
  });
});
