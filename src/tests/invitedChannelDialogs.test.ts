import {createTestClient} from './api/harness';
import type {Message} from '@layer';
import {GLOBAL_FOLDER_ID} from '@lib/storages/dialogs';

describe('invited channel dialogs', () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async() => {
    client = await createTestClient({
      seed: {userId: 990000, dcId: 2, authKeys: {}},
      testDc: true
    });
    // Keep unrelated manager side effects from sending real MTProto requests.
    const apiManager: any = client.apiManager;
    apiManager.invokeApi = (method: string) => {
      throw new Error(`Unexpected API request in invited channel dialog tests: ${method}`);
    };
    apiManager.invokeApiSingleProcess = (options: any) => {
      throw new Error(`Unexpected API request in invited channel dialog tests: ${options.method}`);
    };
    const appMessagesManager: any = client.managers.appMessagesManager;
    const appDraftsManager: any = client.managers.appDraftsManager;
    const appStickersManager: any = client.managers.appStickersManager;
    const appNotificationsManager: any = client.managers.appNotificationsManager;
    vi.spyOn(appMessagesManager, 'getNotifyPeerSettings').mockResolvedValue({
      muted: false,
      peerTypeNotifySettings: {show_previews: true}
    });
    vi.spyOn(appNotificationsManager, 'routeNotification').mockResolvedValue(undefined);
    vi.spyOn(appDraftsManager, 'addMissedDialogs').mockResolvedValue(undefined);
    vi.spyOn(appStickersManager, 'getAnimatedEmojiSounds').mockResolvedValue(undefined);
    vi.spyOn(appStickersManager, 'getLocalStickerSet').mockResolvedValue(undefined);
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

  test('keeps an empty channel dialog when its draft is cleared', () => {
    const channelId = 990030;
    const peerId = (channelId as ChatId).toPeerId(true);
    const channel = makeChannel(channelId);
    client.managers.appChatsManager.saveApiChats([channel]);
    applyEmptyChannelDialog(channel);

    const dialog = client.managers.dialogsStorage.getDialogOnly(peerId);
    expect(dialog).toBeDefined();
    dialog!.draft = {
      _: 'draftMessage',
      date: 1,
      message: 'draft',
      pFlags: {}
    } as any;

    client.managers.rootScope.dispatchEvent('draft_updated', {peerId, draft: undefined} as any);

    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeDefined();
    expect(client.managers.dialogsStorage.getFolderDialogs(0, false).map((item) => item.peerId)).toContain(peerId);
  });

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

  test('stores the first post received while the invited-channel dialog reload is pending', async() => {
    const channelId = 990012;
    const peerId = (channelId as ChatId).toPeerId(true);
    const appMessagesManager: any = client.managers.appMessagesManager;
    const apiManager: any = appMessagesManager.apiManager;
    const originalInvoke = apiManager.invokeApi;
    let resolvePeerDialogs: ((result: any) => void) | undefined;
    apiManager.invokeApi = (method: string) => {
      expect(method).toBe('messages.getPeerDialogs');
      return new Promise((resolve) => {
        resolvePeerDialogs = resolve;
      });
    };

    client.managers.appChatsManager.saveApiChats([makeChannel(channelId)]);
    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
    const reload = appMessagesManager.reloadConversation(peerId);

    try {
      await vi.waitFor(() => expect(resolvePeerDialogs).toBeTypeOf('function'));
      expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
      client.managers.apiUpdatesManager.saveUpdate({
        _: 'updateNewChannelMessage',
        message: {
          _: 'message',
          id: 1,
          peer_id: {_: 'peerChannel', channel_id: channelId},
          date: 2,
          message: 'First channel post',
          pFlags: {post: true}
        }
      } as any);
      expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();

      if(!resolvePeerDialogs) {
        throw new Error('messages.getPeerDialogs was not requested');
      }

      resolvePeerDialogs(makeEmptyChannelDialogResult(makeChannel(channelId), 'messages.peerDialogs'));
      await reload;
      await vi.waitFor(() => {
        expect(client.managers.dialogsStorage.getDialogOnly(peerId)?.top_message).not.toBe(0);
      });

      const dialog = client.managers.dialogsStorage.getDialogOnly(peerId);
      const firstPost = client.managers.appMessagesManager.getMessageByPeer(peerId, dialog.top_message) as Message.message;
      expect(firstPost?.message).toBe('First channel post');
    } finally {
      apiManager.invokeApi = originalInvoke;
    }
  });

  test('stores the first post when the dialog reload response omits the channel', async() => {
    const channelId = 990013;
    const peerId = (channelId as ChatId).toPeerId(true);
    const appMessagesManager: any = client.managers.appMessagesManager;
    const apiManager: any = appMessagesManager.apiManager;
    const originalInvoke = apiManager.invokeApi;
    const response = makeEmptyChannelDialogResult(makeChannel(channelId), 'messages.peerDialogs');
    response.dialogs = [];
    let peerDialogsRequestCount = 0;
    apiManager.invokeApi = (method: string, ...args: any[]) => {
      if(method !== 'messages.getPeerDialogs') {
        return originalInvoke.apply(apiManager, [method, ...args]);
      }

      ++peerDialogsRequestCount;
      return Promise.resolve(response);
    };

    client.managers.appChatsManager.saveApiChats([makeChannel(channelId)]);

    try {
      client.managers.apiUpdatesManager.saveUpdate({
        _: 'updateNewChannelMessage',
        message: {
          _: 'message',
          id: 1,
          peer_id: {_: 'peerChannel', channel_id: channelId},
          date: 3,
          message: 'First channel post',
          pFlags: {post: true}
        }
      } as any);

      await vi.waitFor(() => expect(peerDialogsRequestCount).toBeGreaterThan(0));
      await vi.waitFor(() => {
        expect(client.managers.dialogsStorage.getDialogOnly(peerId)?.top_message).not.toBe(0);
      });

      const dialog = client.managers.dialogsStorage.getDialogOnly(peerId);
      expect(dialog).toBeDefined();
      expect(dialog?.top_message).not.toBe(0);
      const firstPost = client.managers.appMessagesManager.getMessageByPeer(peerId, dialog.top_message) as Message.message;
      expect(firstPost?.message).toBe('First channel post');
    } finally {
      apiManager.invokeApi = originalInvoke;
    }
  });

  test('preserves cached dialog state when replaying a post after an omitted dialog response', async() => {
    const channelId = 990017;
    const peerId = (channelId as ChatId).toPeerId(true);
    const appMessagesManager: any = client.managers.appMessagesManager;
    const apiManager: any = appMessagesManager.apiManager;
    const originalInvoke = apiManager.invokeApi;
    const cachedResponse = makeEmptyChannelDialogResult(makeChannel(channelId), 'messages.peerDialogs');
    Object.assign(cachedResponse.dialogs[0], {
      folder_id: 1,
      read_inbox_max_id: 9,
      read_outbox_max_id: 8,
      unread_count: 4,
      unread_mentions_count: 2,
      unread_reactions_count: 3,
      unread_poll_votes_count: 1
    });
    cachedResponse.dialogs[0].pFlags = {pinned: true};

    const response = makeEmptyChannelDialogResult(makeChannel(channelId), 'messages.peerDialogs');
    response.dialogs = [];
    response.chats = [];
    let resolvePeerDialogs: ((result: any) => void) | undefined;
    apiManager.invokeApi = (method: string, ...args: any[]) => {
      if(method !== 'messages.getPeerDialogs') {
        return originalInvoke.apply(apiManager, [method, ...args]);
      }

      return new Promise((resolve) => {
        resolvePeerDialogs = resolve;
      });
    };

    try {
      client.managers.appChatsManager.saveApiChats([makeChannel(channelId)]);
      client.managers.dialogsStorage.applyDialogs(cachedResponse);
      const reload = appMessagesManager.reloadConversation(peerId);
      await vi.waitFor(() => expect(resolvePeerDialogs).toBeTypeOf('function'));

      client.managers.apiUpdatesManager.saveUpdate({
        _: 'updateNewChannelMessage',
        message: {
          _: 'message',
          id: 1,
          peer_id: {_: 'peerChannel', channel_id: channelId},
          date: 5,
          message: 'First channel post',
          pFlags: {post: true}
        }
      } as any);
      expect(appMessagesManager.newUpdatesAfterReloadToHandle[appMessagesManager.getUpdateAfterReloadKey(peerId)]?.size).toBe(1);

      if(!resolvePeerDialogs) {
        throw new Error('messages.getPeerDialogs was not requested');
      }

      resolvePeerDialogs(response);
      await reload;

      const dialog = client.managers.dialogsStorage.getDialogOnly(peerId);
      expect(dialog).toMatchObject({
        peerId,
        folder_id: 1,
        pFlags: {pinned: true},
        read_inbox_max_id: expect.any(Number),
        read_outbox_max_id: expect.any(Number)
      });
      expect(dialog?.read_inbox_max_id).toBeGreaterThanOrEqual(9);
      expect(dialog?.read_outbox_max_id).toBeGreaterThanOrEqual(8);
      expect(dialog?.unread_count).toBeGreaterThanOrEqual(4);
      expect(dialog?.unread_mentions_count).toBeGreaterThanOrEqual(2);
      expect(dialog?.unread_reactions_count).toBeGreaterThanOrEqual(3);
      expect(dialog?.unread_poll_votes_count).toBeGreaterThanOrEqual(1);
      expect(dialog?.top_message).not.toBe(0);
      const firstPost = client.managers.appMessagesManager.getMessageByPeer(peerId, dialog.top_message) as Message.message;
      expect(firstPost?.message).toBe('First channel post');
    } finally {
      apiManager.invokeApi = originalInvoke;
    }
  });

  test.each([
    ['left', 990014, (id: number) => makeChannel(id, {left: true})],
    ['kicked', 990015, (id: number) => makeChannel(id, {kicked: true})],
    ['forbidden', 990016, makeForbiddenChannel]
  ])('does not synthesize a dialog if membership becomes %s during reload', async(_membership, channelId, makeRemovedChannel) => {
    const testChannelId = channelId as number;
    const peerId = (testChannelId as ChatId).toPeerId(true);
    const appChatsManager: any = client.managers.appChatsManager;
    const appMessagesManager: any = client.managers.appMessagesManager;
    const apiManager: any = appMessagesManager.apiManager;
    const originalInvoke = apiManager.invokeApi;
    const response = makeEmptyChannelDialogResult(makeChannel(testChannelId), 'messages.peerDialogs');
    response.dialogs = [];
    response.chats = [];
    let resolvePeerDialogs: ((result: any) => void) | undefined;
    apiManager.invokeApi = (method: string, ...args: any[]) => {
      if(method !== 'messages.getPeerDialogs') {
        return originalInvoke.apply(apiManager, [method, ...args]);
      }

      return new Promise((resolve) => {
        resolvePeerDialogs = resolve;
      });
    };

    appChatsManager.saveApiChats([makeChannel(testChannelId)]);

    try {
      client.managers.apiUpdatesManager.saveUpdate({
        _: 'updateNewChannelMessage',
        message: {
          _: 'message',
          id: 1,
          peer_id: {_: 'peerChannel', channel_id: testChannelId},
          date: 4,
          message: 'First channel post',
          pFlags: {post: true}
        }
      } as any);

      await vi.waitFor(() => expect(resolvePeerDialogs).toBeTypeOf('function'));
      expect(appMessagesManager.newUpdatesAfterReloadToHandle[appMessagesManager.getUpdateAfterReloadKey(peerId)]?.size).toBe(1);
      appChatsManager.saveApiChats([(makeRemovedChannel as (id: number) => any)(testChannelId)]);
      expect(appChatsManager.isInChat(testChannelId)).toBe(false);
      const reload = appMessagesManager.reloadConversationsPeers.get(peerId).promise;

      if(!resolvePeerDialogs) {
        throw new Error('messages.getPeerDialogs was not requested');
      }

      resolvePeerDialogs(response);
      await reload;

      expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
    } finally {
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
  function makeChannelDialogsPage(channels: any[], count: number) {
    const page = makeEmptyChannelDialogResult(channels[0], 'messages.dialogsSlice');
    page.dialogs = channels.map((channel) => ({...page.dialogs[0], peer: {_: 'peerChannel', channel_id: channel.id}, top_message: 1}));
    page.chats = channels;
    page.count = count;
    return page;
  }

  async function getCachedListWithServer(
    channel: any,
    {
      pages = [makeChannelDialogsPage([channel], 1)],
      failFirstList = false,
      failFirstPeerDialogs = false
    }: {pages?: any[], failFirstList?: boolean, failFirstPeerDialogs?: boolean} = {}
  ) {
    const dialogsStorage: any = client.managers.dialogsStorage;
    const apiManager: any = (client.managers.appMessagesManager as any).apiManager;
    const originalInvoke = apiManager.invokeApi;
    const originalInvokeSingleProcess = apiManager.invokeApiSingleProcess;
    const allDialogsLoaded = dialogsStorage.allDialogsLoaded;
    const requests: string[] = [];
    const listParams: any[] = [];
    apiManager.invokeApiSingleProcess = (options: any) => {
      if(options.method !== 'messages.getDialogs') {
        return originalInvokeSingleProcess.call(apiManager, options);
      }

      requests.push(options.method);
      if(failFirstList && requests.length === 1) {
        return Promise.reject(Object.assign(new Error('NETWORK_BAD_REQUEST'), {type: 'NETWORK_BAD_REQUEST'}));
      }

      // * the first page is the one asked from the top of the list, the rest follow its offset
      const pageIndex = options.params.offset_peer._ === 'inputPeerEmpty' ? 0 : listParams.filter((params) => params.offset_peer._ !== 'inputPeerEmpty').length + 1;
      listParams.push(options.params);
      return Promise.resolve(options.processResult(pages[pageIndex]));
    };
    let peerDialogsRequestCount = 0;
    apiManager.invokeApi = (method: string, ...args: any[]) => {
      if(method !== 'messages.getPeerDialogs') {
        return originalInvoke.apply(apiManager, [method, ...args]);
      }

      requests.push(method);
      if(failFirstPeerDialogs && ++peerDialogsRequestCount === 1) {
        return Promise.reject(Object.assign(new Error('NETWORK_BAD_REQUEST'), {type: 'NETWORK_BAD_REQUEST'}));
      }

      return Promise.resolve(makeEmptyChannelDialogResult(channel, 'messages.peerDialogs'));
    };

    // * a completed full load marks every real folder and the global cursor as loaded
    dialogsStorage.allDialogsLoaded = {...allDialogsLoaded};
    dialogsStorage.setDialogsLoaded(0, true);
    dialogsStorage.setDialogsLoaded(GLOBAL_FOLDER_ID, true);
    dialogsStorage.cachedListReconciled = false;
    const restore = () => {
      apiManager.invokeApi = originalInvoke;
      apiManager.invokeApiSingleProcess = originalInvokeSingleProcess;
      dialogsStorage.allDialogsLoaded = allDialogsLoaded;
    };

    try {
      await dialogsStorage.getDialogs({limit: 20, filterId: 0});
      await vi.waitFor(() => expect(requests).toContain('messages.getDialogs'));
      if(failFirstList || failFirstPeerDialogs) {
        await vi.waitFor(() => expect(dialogsStorage.cachedListReconciled).toBe(false));
      }

      await dialogsStorage.getDialogs({limit: 20, filterId: 0});
    } catch(err) {
      restore();
      throw err;
    }

    return {requests, listParams, restore};
  }

  test.each([
    ['its peer is cached', true],
    ['its peer never reached the client', false]
  ])('lists a joined channel that a fully loaded cache missed when %s', async(_name, isPeerCached) => {
    const channelId = isPeerCached ? 990040 : 990041;
    const peerId = (channelId as ChatId).toPeerId(true);
    if(isPeerCached) {
      client.managers.appChatsManager.saveApiChats([makeChannel(channelId)]);
    }

    expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
    const {requests, restore} = await getCachedListWithServer(makeChannel(channelId));

    try {
      await vi.waitFor(() => {
        expect(client.managers.dialogsStorage.getFolderDialogs(0, false).map((dialog) => dialog.peerId)).toContain(peerId);
      });
      expect(requests.filter((method) => method === 'messages.getDialogs')).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test('retries the server list when the first comparison fails', async() => {
    const channelId = 990045;
    const peerId = (channelId as ChatId).toPeerId(true);
    client.managers.appChatsManager.saveApiChats([makeChannel(channelId)]);

    const {requests, restore} = await getCachedListWithServer(makeChannel(channelId), {failFirstList: true});

    try {
      await vi.waitFor(() => {
        expect(client.managers.dialogsStorage.getFolderDialogs(0, false).map((dialog) => dialog.peerId)).toContain(peerId);
      });
      expect(requests.filter((method) => method === 'messages.getDialogs')).toHaveLength(2);
    } finally {
      restore();
    }
  });

  test('finds a missed channel on a later page of the server list', async() => {
    const listedChannel = makeChannel(990046);
    const missedChannel = makeChannel(990047);
    const missedPeerId = (missedChannel.id as ChatId).toPeerId(true);
    client.managers.appChatsManager.saveApiChats([listedChannel, missedChannel]);
    applyEmptyChannelDialog(listedChannel);

    const {listParams, restore} = await getCachedListWithServer(missedChannel, {
      pages: [makeChannelDialogsPage([listedChannel], 2), makeChannelDialogsPage([missedChannel], 2)]
    });

    try {
      await vi.waitFor(() => {
        expect(client.managers.dialogsStorage.getFolderDialogs(0, false).map((dialog) => dialog.peerId)).toContain(missedPeerId);
      });
      expect(listParams).toHaveLength(2);
      expect(listParams[1].offset_peer).toMatchObject({_: 'inputPeerChannel', channel_id: listedChannel.id});
    } finally {
      restore();
    }
  });

  test('retries a channel whose dialog fetch failed after the list was compared', async() => {
    const channelId = 990048;
    const peerId = (channelId as ChatId).toPeerId(true);
    client.managers.appChatsManager.saveApiChats([makeChannel(channelId)]);

    const {requests, restore} = await getCachedListWithServer(makeChannel(channelId), {failFirstPeerDialogs: true});

    try {
      await vi.waitFor(() => {
        expect(client.managers.dialogsStorage.getFolderDialogs(0, false).map((dialog) => dialog.peerId)).toContain(peerId);
      });
      expect(requests.filter((method) => method === 'messages.getPeerDialogs')).toHaveLength(2);
    } finally {
      restore();
    }
  });

  test.each([
    ['left', 990042, (id: number) => makeChannel(id, {left: true})],
    ['kicked', 990043, (id: number) => makeChannel(id, {kicked: true})],
    ['banned', 990044, makeForbiddenChannel]
  ])('does not restore a %s channel from the server list', async(_membership, channelId, makeRemovedChannel) => {
    const peerId = (channelId as number).toPeerId(true);
    const removedChannel = (makeRemovedChannel as (id: number) => any)(channelId as number);
    client.managers.appChatsManager.saveApiChats([makeChannel(channelId as number)]);

    const {requests, restore} = await getCachedListWithServer(removedChannel);

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(requests).not.toContain('messages.getPeerDialogs');
      expect(client.managers.dialogsStorage.getDialogOnly(peerId)).toBeUndefined();
      expect(client.managers.appChatsManager.isInChat(channelId as number)).toBe(false);
    } finally {
      restore();
    }
  });
});
