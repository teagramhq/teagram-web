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

  function makeNonEmptyChannelDialogResult(channel: any) {
    const result = makeEmptyChannelDialogResult(channel, 'messages.peerDialogs');
    result.dialogs[0].top_message = 1;
    return result;
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

  function makeForbiddenChannel(id: number) {
    return {
      _: 'channelForbidden',
      id,
      access_hash: '1',
      title: 'Invited channel',
      pFlags: {megagroup: true}
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
    ['kicked or banned channel', 990003, makeForbiddenChannel]
  ])('does not restore an empty channel after the user is %s', (_name, channelId, makeRemovedChannel) => {
    const peerId = (channelId as number).toPeerId(true);

    applyEmptyChannelDialog(makeChannel(channelId as number));
    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeDefined();

    applyEmptyChannelDialog((makeRemovedChannel as (id: number) => any)(channelId as number));

    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
  });

  test('drops a cached dialog when a chat vector marks the channel forbidden', () => {
    const channelId = 990005;
    const peerId = (channelId as ChatId).toPeerId(true);
    const appChatsManager: any = client.managers.appChatsManager;
    const dialogsStorage: any = client.managers.dialogsStorage;

    client.managers.dialogsStorage.applyDialogs(makeNonEmptyChannelDialogResult(makeChannel(channelId)));
    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeDefined();

    // The persisted dialog can outlive the in-memory peer cache during startup.
    delete appChatsManager.chats[channelId];
    client.managers.dialogsStorage.applyDialogs({
      _: 'messages.dialogs',
      dialogs: [],
      messages: [],
      chats: [makeForbiddenChannel(channelId)],
      users: []
    } as any);

    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
    expect(client.managers.dialogsStorage.getFolderDialogs(0, false).map((dialog) => dialog.peerId)).not.toContain(peerId);
    expect(dialogsStorage.storage.getFromCache(peerId)).toBeUndefined();

    const staleDialog = makeNonEmptyChannelDialogResult(makeChannel(channelId)).dialogs[0];
    staleDialog.peerId = peerId;
    dialogsStorage.dialogs[peerId] = staleDialog;
    client.managers.dialogsStorage.applyDialogs({
      _: 'messages.peerDialogs',
      dialogs: [staleDialog],
      messages: [],
      chats: [],
      users: [],
      state: {_: 'updates.state', date: 0, pts: 0, qts: 0, seq: 0, unread_count: 0}
    } as any);

    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
  });

  test('deletes a forbidden persisted dialog during startup hydration', async() => {
    const channelId = 990011;
    const peerId = (channelId as ChatId).toPeerId(true);
    const appChatsManager: any = client.managers.appChatsManager;
    const appMessagesManager: any = client.managers.appMessagesManager;
    const dialogsStorage: any = client.managers.dialogsStorage;
    const storage: any = dialogsStorage.storage;
    const staleDialog = makeNonEmptyChannelDialogResult(makeChannel(channelId)).dialogs[0];
    staleDialog.peerId = peerId;
    const storageKey = String(peerId);
    const originalChat = appChatsManager.chats[channelId];
    const originalReloadConversation = appMessagesManager.reloadConversation;

    await storage.set({[storageKey]: staleDialog});
    expect((await storage.getAllEntries()).some(([key]: [IDBValidKey, any]) => key === storageKey)).toBe(true);

    // Startup reads the persisted snapshot while the in-memory dialog map is still empty.
    delete dialogsStorage.dialogs[peerId];
    appChatsManager.chats[channelId] = makeForbiddenChannel(channelId);
    appMessagesManager.reloadConversation = () => Promise.resolve();

    try {
      dialogsStorage.setDialogsFromState([staleDialog]);

      const deletion = storage.keysToDelete.has(storageKey) ? storage.deleteDeferred : undefined;
      if(deletion) {
        await deletion;
      }

      expect((await storage.getAllEntries()).some(([key]: [IDBValidKey, any]) => key === storageKey)).toBe(false);
    } finally {
      await storage.delete(peerId);
      appMessagesManager.reloadConversation = originalReloadConversation;
      if(originalChat) {
        appChatsManager.chats[channelId] = originalChat;
      } else {
        delete appChatsManager.chats[channelId];
      }
    }
  });

  test('does not restore a kicked channel dialog from an incoming channel message update', async() => {
    const channelId = 990006;
    const peerId = (channelId as ChatId).toPeerId(true);
    const appChatsManager: any = client.managers.appChatsManager;
    const dialogsStorage: any = client.managers.dialogsStorage;
    const appMessagesManager: any = client.managers.appMessagesManager;

    client.managers.dialogsStorage.applyDialogs(makeEmptyChannelDialogResult(makeChannel(channelId), 'messages.peerDialogs'));
    const staleDialog = client.managers.dialogsStorage.getDialogOnly(peerId);
    appChatsManager.chats[channelId] = makeChannel(channelId, {kicked: true});
    dialogsStorage.dialogs[peerId] = staleDialog;

    client.managers.apiUpdatesManager.saveUpdate({
      _: 'updateNewChannelMessage',
      message: {
        _: 'message',
        id: 1,
        peer_id: {_: 'peerChannel', channel_id: channelId},
        date: 1,
        message: 'New post after removal',
        pFlags: {post: true}
      }
    } as any);
    await appMessagesManager.newDialogsHandlePromise;

    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
    expect(client.managers.dialogsStorage.getFolderDialogs(0, false).map((dialog) => dialog.peerId)).not.toContain(peerId);
  });

  test('drops a cached dialog when an updateChannel refetch finds the channel forbidden', () => {
    const channelId = 990010;
    const peerId = (channelId as ChatId).toPeerId(true);
    const appChatsManager: any = client.managers.appChatsManager;

    client.managers.dialogsStorage.applyDialogs(makeEmptyChannelDialogResult(makeChannel(channelId), 'messages.peerDialogs'));
    appChatsManager.chats[channelId] = makeForbiddenChannel(channelId);

    client.managers.apiUpdatesManager.processLocalUpdate({
      _: 'updateChannel',
      channel_id: channelId
    } as any);

    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
    expect(client.managers.dialogsStorage.getFolderDialogs(0, false).map((dialog) => dialog.peerId)).not.toContain(peerId);
  });

  test.each(['PEER_ID_INVALID', 'CHANNEL_PRIVATE', 'CHANNEL_INVALID'])('drops a channel dialog after getChannelDifference returns %s', async(errorType) => {
    const channelId = 990007 + ['PEER_ID_INVALID', 'CHANNEL_PRIVATE', 'CHANNEL_INVALID'].indexOf(errorType);
    const peerId = (channelId as ChatId).toPeerId(true);
    const appMessagesManager: any = client.managers.appMessagesManager;
    const apiUpdatesManager: any = client.managers.apiUpdatesManager;
    const apiManager: any = appMessagesManager.apiManager;
    const originalInvoke = apiManager.invokeApi;

    client.managers.appChatsManager.saveApiChats([makeChannel(channelId)]);
    client.managers.dialogsStorage.applyDialogs(makeEmptyChannelDialogResult(makeChannel(channelId), 'messages.peerDialogs'));
    apiUpdatesManager.channelStates ??= {};
    apiUpdatesManager.channelStates[channelId] = {pts: 1, pendingPtsUpdates: [], syncPending: null, syncLoading: null};
    apiManager.invokeApi = () => Promise.reject(Object.assign(new Error(errorType), {type: errorType}));

    try {
      await expect(apiUpdatesManager.getChannelDifference(channelId)).rejects.toMatchObject({type: errorType});
      expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
      expect(client.managers.appChatsManager.getChat(channelId)._).toBe('channelForbidden');
    } finally {
      apiManager.invokeApi = originalInvoke;
    }
  });
});
