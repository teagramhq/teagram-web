import type {MyDialogFilter} from '@lib/storages/filters';
import {createTestClient} from './api/harness';

// Saved dialogs are keyed by the user's own peer id, while folders are keyed by
// dialog filter id. A user whose id is also the id of one of their folders must
// keep the All Chats index on every dialog.
describe('dialog filter with the user\'s own id', () => {
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

  function addSelfIdFilter() {
    const filtersStorage: any = client.managers.filtersStorage;
    const id = client.managers.appPeersManager.peerId;
    const filter: MyDialogFilter = {
      _: 'dialogFilter',
      id,
      localId: 4,
      title: {_: 'textWithEntities', text: 'Personal', entities: []},
      pFlags: {contacts: true, non_contacts: true, bots: true},
      pinned_peers: [],
      include_peers: [],
      exclude_peers: [],
      pinnedPeerIds: [],
      includePeerIds: [],
      excludePeerIds: []
    };
    filtersStorage.filters[id] = filter;
    return filter;
  }

  function removeFilter(filter: {id: number}) {
    delete (client.managers.filtersStorage as any).filters[filter.id];
  }

  function makeChannel(id: number) {
    return {
      _: 'channel',
      id,
      access_hash: '1',
      title: 'Invited channel',
      date: 1700000000,
      version: 1,
      photo: {_: 'chatPhotoEmpty'},
      pFlags: {broadcast: true}
    } as any;
  }

  function persistEmptyChannelDialog(channelId: number) {
    const peerId = (channelId as ChatId).toPeerId(true);
    const dialogsStorage: any = client.managers.dialogsStorage;
    client.managers.appChatsManager.saveApiChats([makeChannel(channelId)]);
    dialogsStorage.applyDialogs({
      _: 'messages.peerDialogs',
      dialogs: [{
        _: 'dialog',
        peer: {_: 'peerChannel', channel_id: channelId},
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
      chats: [],
      users: [],
      state: {_: 'updates.state', date: 0, pts: 0, qts: 0, seq: 0, unread_count: 0}
    });

    return {peerId, persisted: structuredClone(dialogsStorage.getDialogOnly(peerId))};
  }

  test('keeps the All Chats index when that folder is deleted', () => {
    const dialogsStorage: any = client.managers.dialogsStorage;
    const {peerId} = persistEmptyChannelDialog(990102);
    const filter = addSelfIdFilter();

    try {
      client.managers.rootScope.dispatchEvent('filter_delete', filter);

      expect(dialogsStorage.getDialogIndex(peerId, 'index_0')).toBeGreaterThan(0);
    } finally {
      removeFilter(filter);
      dialogsStorage.dropDialog(peerId);
    }
  });

  test('restores an invited empty channel into All Chats after reload', async() => {
    const dialogsStorage: any = client.managers.dialogsStorage;
    const appMessagesManager: any = client.managers.appMessagesManager;
    const {peerId, persisted} = persistEmptyChannelDialog(990101);
    const filter = addSelfIdFilter();
    const originalReloadConversation = appMessagesManager.reloadConversation;

    // Startup reads the persisted snapshot while the folders are still empty.
    dialogsStorage.dropDialog(peerId);
    dialogsStorage.dialogs[peerId] = persisted;
    appMessagesManager.reloadConversation = () => Promise.resolve();

    try {
      dialogsStorage.setDialogsFromState([persisted]);

      expect(dialogsStorage.getDialogIndex(peerId, 'index_0')).toBeGreaterThan(0);
      const {dialogs} = await dialogsStorage.getDialogs({filterId: 0, limit: 20, forceLocal: true});
      expect(dialogs.map((dialog: any) => dialog.peerId)).toContain(peerId);
    } finally {
      appMessagesManager.reloadConversation = originalReloadConversation;
      removeFilter(filter);
      dialogsStorage.dropDialog(peerId);
    }
  });
});
