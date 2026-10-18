import type {MyDialogFilter} from '@lib/storages/filters';
import {FilterType} from '@lib/storages/dialogs';
import {createTestClient} from './api/harness';

describe('folder and Saved dialogs with the same id', () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async() => {
    client = await createTestClient({
      seed: {userId: 2, dcId: 2, authKeys: {}},
      testDc: true
    });
  }, 60_000);

  afterAll(() => {
    client?.dispose();
  });

  async function expectSeparateDialogs(userId: number) {
    const filtersStorage: any = client.managers.filtersStorage;
    const dialogsStorage: any = client.managers.dialogsStorage;
    const appUsersManager: any = client.managers.appUsersManager;
    const appPeersManager: any = client.managers.appPeersManager;
    const originalFillContacts = appUsersManager.fillContacts;
    const originalReloadMissingPeerIds = filtersStorage.reloadMissingPeerIds;
    const selfPeerId = appPeersManager.peerId;
    const folderPeerId = (700000 as UserId).toPeerId(false);
    const savedPeerId = (700001 as UserId).toPeerId(false);
    const filter: MyDialogFilter = {
      _: 'dialogFilter',
      id: userId,
      localId: undefined,
      title: {_: 'textWithEntities', text: 'Personal', entities: []},
      pFlags: {contacts: true, non_contacts: true, bots: true},
      pinned_peers: [],
      include_peers: [],
      exclude_peers: [],
      pinnedPeerIds: [],
      includePeerIds: [folderPeerId],
      excludePeerIds: []
    };

    appUsersManager.fillContacts = () => ({cached: true});
    filtersStorage.reloadMissingPeerIds = (): undefined => undefined;

    try {
      filtersStorage.saveDialogFilter(filter, false);

      const folderDialog = {
        _: 'dialog',
        peerId: folderPeerId,
        folder_id: 0,
        top_message: 0,
        pFlags: {},
        unread_count: 0,
        unread_mentions_count: 0,
        unread_reactions_count: 0
      } as any;
      dialogsStorage.dialogs[folderPeerId] = folderDialog;
      dialogsStorage.processDialogForFilter(folderDialog, filtersStorage.getFilter(0));
      dialogsStorage.processDialogForFilter(folderDialog, filter);

      filtersStorage.saveDialogFilter(filter);

      const savedDialog = {
        _: 'savedDialog',
        peer: {_: 'peerUser', user_id: savedPeerId.toUserId()},
        peerId: selfPeerId,
        savedPeerId,
        top_message: 1,
        pFlags: {}
      } as any;
      dialogsStorage.processDialogForFilter(savedDialog);
      dialogsStorage.savedDialogs[savedPeerId] = savedDialog;

      const originalGetLimit = client.apiManager.getLimit;
      const originalInvokeApi = client.apiManager.invokeApi;
      const originalGetInputDialogPeerById = appPeersManager.getInputDialogPeerById;
      const originalGetDialogPeer = appPeersManager.getDialogPeer;
      const apiUpdatesManager: any = client.managers.apiUpdatesManager;
      const originalSaveUpdate = apiUpdatesManager.saveUpdate;
      const invokeCalls: [string, any][] = [];
      dialogsStorage.pinnedOrders[userId] = [folderPeerId];
      dialogsStorage.savedDialogsPinnedOrder = [];
      client.apiManager.getLimit = (() => Promise.resolve(1)) as any;
      client.apiManager.invokeApi = ((method: string, params: any) => {
        invokeCalls.push([method, params]);
        return Promise.resolve(true);
      }) as any;
      appPeersManager.getInputDialogPeerById = (): any => ({
        _: 'inputDialogPeer',
        peer: {_: 'inputPeerUser', user_id: savedPeerId.toUserId()}
      });
      appPeersManager.getDialogPeer = () => savedDialog.peer;
      apiUpdatesManager.saveUpdate = (): void => {};

      try {
        await client.managers.appMessagesManager.toggleDialogPin({
          peerId: selfPeerId,
          topicOrSavedId: savedPeerId
        });
        expect(invokeCalls).toContainEqual([
          'messages.toggleSavedDialogPin',
          expect.objectContaining({pinned: true})
        ]);
      } finally {
        client.apiManager.getLimit = originalGetLimit;
        client.apiManager.invokeApi = originalInvokeApi;
        appPeersManager.getInputDialogPeerById = originalGetInputDialogPeerById;
        appPeersManager.getDialogPeer = originalGetDialogPeer;
        apiUpdatesManager.saveUpdate = originalSaveUpdate;
      }

      expect(dialogsStorage.getFilterType(userId)).toBe(FilterType.Folder);
      expect(dialogsStorage.isVirtualFilter(userId)).toBe(false);
      expect(dialogsStorage.getFolder(userId)).not.toBe(dialogsStorage.getFolder(userId, FilterType.Saved));

      const folderResult = await dialogsStorage.getDialogs({
        filterId: userId,
        limit: 20,
        forceLocal: true
      });
      const savedResult = await dialogsStorage.getDialogs({
        filterId: userId,
        filterType: FilterType.Saved,
        limit: 20,
        forceLocal: true
      });

      expect(folderResult.dialogs.map((dialog: any) => dialog.peerId)).toEqual([folderPeerId]);
      expect(savedResult.dialogs.map((dialog: any) => dialog.savedPeerId)).toEqual([savedPeerId]);

      filter.includePeerIds = [];
      filter.pFlags = {};
      filtersStorage.saveDialogFilter(filter);
      dialogsStorage.processDialogForFilter(folderDialog, filter);
      expect((await dialogsStorage.getDialogs({
        filterId: userId,
        limit: 20,
        forceLocal: true
      })).dialogs).toEqual([]);

      filter.includePeerIds = [folderPeerId];
      filter.pFlags = {contacts: true, non_contacts: true, bots: true};
      filtersStorage.saveDialogFilter(filter);
      dialogsStorage.processDialogForFilter(folderDialog, filter);

      filtersStorage.onUpdateDialogFilterOrder({
        _: 'updateDialogFilterOrder',
        order: [0, 1, userId]
      });
      expect((await dialogsStorage.getDialogs({
        filterId: userId,
        limit: 20,
        forceLocal: true
      })).dialogs.map((dialog: any) => dialog.peerId)).toEqual([folderPeerId]);
      expect((await dialogsStorage.getDialogs({
        filterId: userId,
        filterType: FilterType.Saved,
        limit: 20,
        forceLocal: true
      })).dialogs.map((dialog: any) => dialog.savedPeerId)).toEqual([savedPeerId]);

      filtersStorage.onUpdateDialogFilter({_: 'updateDialogFilter', id: userId});
      expect((await dialogsStorage.getDialogs({
        filterId: userId,
        filterType: FilterType.Saved,
        limit: 20,
        forceLocal: true
      })).dialogs.map((dialog: any) => dialog.savedPeerId)).toEqual([savedPeerId]);
    } finally {
      appUsersManager.fillContacts = originalFillContacts;
      filtersStorage.reloadMissingPeerIds = originalReloadMissingPeerIds;
    }
  }

  test('keeps a seeded folder separate from Saved Messages when the user id is 2', async() => {
    await expectSeparateDialogs(2);
  });

  test('keeps a user-created folder separate from Saved Messages when the user id is 100', async() => {
    const appPeersManager: any = client.managers.appPeersManager;
    const dialogsStorage: any = client.managers.dialogsStorage;

    Object.defineProperty(appPeersManager, 'peerId', {configurable: true, value: 100});
    dialogsStorage.savedDialogsFolder = undefined;
    dialogsStorage.savedDialogs = {};
    dialogsStorage.savedDialogsLoaded = false;
    dialogsStorage.savedDialogsOffsetDate = 0;
    dialogsStorage.savedDialogsPinnedOrder = [];

    await expectSeparateDialogs(100);
  });
});
