import {expect, test, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {AppMessagesManager} from '@appManagers/appMessagesManager';
import DialogsStorage, {FilterType} from '@lib/storages/dialogs';

type Cursor = {peerId: number, id: number};

function createStorage(dialogs: any[] = [], cursor?: Cursor) {
  const storage = Object.create(DialogsStorage.prototype) as any;
  storage.dialogs = Object.fromEntries(dialogs.map((dialog) => [dialog.peerId, dialog]));
  storage.dialogsOffsetCursors = cursor ? {undefined: cursor} : {};
  storage.appStateManager = {pushToState: vi.fn()};
  storage.appPeersManager = {getPeerId: ({user_id}: any) => user_id};
  return storage as DialogsStorage & {appStateManager: {pushToState: ReturnType<typeof vi.fn>}};
}

function createDialog(peerId: number, top_message: number, extra: any = {}) {
  return {
    _: 'dialog',
    peerId,
    peer: {_: 'peerUser', user_id: peerId},
    top_message,
    read_inbox_max_id: 1,
    read_outbox_max_id: 1,
    pFlags: {},
    ...extra
  };
}

function createRawDialog(peerId: number, top_message: number) {
  return {
    _: 'dialog' as const,
    peer: {_: 'peerUser' as const, user_id: peerId},
    top_message
  };
}

async function createStorageFromState(dialogsOffsetCursors: any) {
  const storage = new DialogsStorage();
  Object.assign(storage, {
    appStateManager: {
      userId: 1,
      snapshotOwner: undefined,
      getState: async() => ({pinnedOrders: {}, allDialogsLoaded: {}, dialogsOffsetCursors}),
      pushToState: vi.fn()
    },
    appStoragesManager: {
      snapshotEpoch: Promise.resolve(undefined),
      loadStorage: async(): Promise<any> => ({results: [], storage: {getCache: () => ({})}})
    },
    rootScope: {addEventListener: vi.fn()},
    apiUpdatesManager: {addMultipleEventsListeners: vi.fn()},
    appDraftsManager: {addMissedDialogs: vi.fn()}
  });

  await (storage as any).after();
  return storage;
}

function createManager(options: {
  cursor?: Cursor,
  offsetDate: number,
  requests: any[],
  pages: any[][],
  persisted?: Cursor[],
  cachedDialogs?: any[]
}) {
  const log = Object.assign(vi.fn(), {bindPrefix: () => log, error: vi.fn()});
  const setDialogsLoaded = vi.fn();
  let cursor = options.cursor;
  const storage = {
    getOffsetDate: () => options.offsetDate,
    getOffsetCursor: () => cursor,
    setOffsetCursor: vi.fn((_folderId: number, dialog: any) => {
      const nextCursor = dialog.peer ? {
        peerId: dialog.peerId ?? (dialog.peer.user_id ?? -dialog.peer.channel_id),
        id: dialog.top_message
      } : dialog;
      cursor = nextCursor;
      options.persisted?.push(nextCursor);
      return nextCursor;
    }),
    getDialogPeerId: (dialog: any) => dialog.peerId ?? (dialog.peer.user_id ?? -dialog.peer.channel_id),
    isVirtualFilter: () => false,
    filterDialogsForStorage: (dialogs: any[]) => dialogs,
    saveDialog: vi.fn(),
    getFolderDialogs: (): any[] => options.cachedDialogs || [],
    setDialogsLoaded,
    getCachedCursor: () => options.persisted?.[options.persisted.length - 1]
  };
  const manager = Object.create(AppMessagesManager.prototype) as any;
  let pageIndex = 0;
  Object.assign(manager, {
    apiManager: {
      invokeApiSingleProcess: async({params, processResult}: any) => {
        options.requests.push(params);
        const dialogs = options.pages[pageIndex++] || [];
        return processResult({_: 'messages.dialogsSlice', count: 500, dialogs, chats: [], users: [], messages: []});
      }
    },
    appPeersManager: {
      getInputPeerById: (peerId: number) => peerId ? {_: 'inputPeerUser', user_id: peerId} : {_: 'inputPeerEmpty'},
      getPeerId: ({user_id, channel_id}: any) => user_id ?? -channel_id,
      isChannel: () => false
    },
    appCommunitiesManager: {getCommunityDialogsCount: () => 0},
    timeManager: {getServerTimeOffset: () => 0},
    appDraftsManager: {addMissedDialogs: vi.fn()},
    dialogsStorage: storage,
    getChannelAvailableMinIdGeneration: () => 0,
    getMessageByPeer: vi.fn(),
    saveApiResult: vi.fn(),
    middleware: {get: () => () => true},
    rootScope: {dispatchEvent: vi.fn()},
    log
  });
  return {manager, setDialogsLoaded, storage};
}

test('requests after the persisted server cursor despite an older cached outlier', async() => {
  const requests: any[] = [];
  const {manager} = createManager({
    cursor: {peerId: 2, id: 500},
    offsetDate: 1000,
    requests,
    pages: [[]],
    cachedDialogs: [
      createDialog(1, 900, {pFlags: {pinned: true}}),
      createDialog(2, 500),
      createDialog(3, 100)
    ]
  });

  await manager.getTopMessages({limit: 100, folderId: undefined, filterType: FilterType.Folder});

  expect(requests[0]).toMatchObject({offset_id: 500, offset_peer: {_: 'inputPeerUser', user_id: 2}});
});

test('writes cursor updates to account state', () => {
  const storage = createStorage();
  const dialog = createRawDialog(8, 0);
  (storage as any).dialogsOffsetCursors = undefined;

  expect(storage.getOffsetCursor(undefined)).toBeUndefined();

  storage.setOffsetCursor(undefined, dialog);

  expect(storage.appStateManager.pushToState).toHaveBeenCalledWith('dialogsOffsetCursors', {undefined: {peerId: 8, id: 0}});
  expect(storage.getOffsetCursor(undefined)).toEqual({peerId: 8, id: 0});
});

test('returns a copy of the stored cursor', () => {
  const storage = createStorage([], {peerId: 8, id: 40});
  const cursor = storage.getOffsetCursor(undefined)!;

  cursor.id = 99;

  expect(storage.getOffsetCursor(undefined)).toEqual({peerId: 8, id: 40});
});

test('restores valid cursors and drops malformed persisted entries', async() => {
  const storage = await createStorageFromState({
    undefined: {peerId: -12, id: 0},
    0: {peerId: 0, id: 42},
    1: {peerId: -13},
    2: {peerId: -14, id: '15'},
    3: {peerId: -15, id: -1},
    4: {peerId: -16, id: 2.5}
  });

  expect(storage.getOffsetCursor(undefined)).toEqual({peerId: -12, id: 0});
  expect(storage.getOffsetCursor(0)).toBeUndefined();
  expect(storage.getOffsetCursor(1)).toBeUndefined();
  expect(storage.getOffsetCursor(2)).toBeUndefined();
  expect(storage.getOffsetCursor(3)).toBeUndefined();
  expect(storage.getOffsetCursor(4)).toBeUndefined();
});

test('clears persisted dialog cursors with the dialog storage', () => {
  const storage = new DialogsStorage() as any;
  const pushToState = vi.fn();
  Object.assign(storage, {
    dialogsOffsetCursors: {undefined: {peerId: 8, id: 40}},
    storage: {clear: vi.fn().mockResolvedValue(undefined)},
    appStateManager: {pushToState},
    resetPinnedOrder: vi.fn()
  });

  storage.clear();

  expect(storage.dialogsOffsetCursors).toEqual({});
  expect(pushToState).toHaveBeenCalledWith('dialogsOffsetCursors', {});
});

test('persists the last raw page entry, including the peer tie-breaker for equal IDs', async() => {
  const requests: any[] = [];
  const persisted: Cursor[] = [];
  const {manager, storage} = createManager({
    cursor: {peerId: 7, id: 300},
    offsetDate: 1000,
    requests,
    persisted,
    pages: [[createRawDialog(8, 200), createRawDialog(11, 200)]]
  });

  await manager.getTopMessages({limit: 100, folderId: undefined, filterType: FilterType.Folder});

  expect(requests[0]).toMatchObject({offset_id: 300, offset_peer: {_: 'inputPeerUser', user_id: 7}});
  expect(storage.setOffsetCursor).toHaveBeenCalledWith(undefined, expect.objectContaining({peer: {_: 'peerUser', user_id: 11}, top_message: 200}));
  expect(persisted).toEqual([{peerId: 11, id: 200}]);
});

test('retains a zero message ID with its peer as the next page cursor', async() => {
  const requests: any[] = [];
  const persisted: Cursor[] = [];
  const {manager} = createManager({
    cursor: {peerId: 7, id: 300},
    offsetDate: 1000,
    requests,
    persisted,
    pages: [[createRawDialog(8, 0)], [createRawDialog(9, 0)]]
  });
  const options = {limit: 100, folderId: undefined as number, filterType: FilterType.Folder};

  await manager.getTopMessages(options);
  await manager.getTopMessages(options);

  expect(persisted).toEqual([{peerId: 8, id: 0}, {peerId: 9, id: 0}]);
  expect(requests[1]).toMatchObject({offset_id: 0, offset_peer: {_: 'inputPeerUser', user_id: 8}});
});

test('uses a stored cursor when the dialog offset date is zero', async() => {
  const requests: any[] = [];
  const {manager} = createManager({
    cursor: {peerId: 8, id: 0},
    offsetDate: 0,
    requests,
    pages: [[]]
  });

  await manager.getTopMessages({limit: 100, folderId: undefined, filterType: FilterType.Folder});

  expect(requests[0]).toMatchObject({
    offset_date: 0,
    offset_id: 0,
    offset_peer: {_: 'inputPeerUser', user_id: 8}
  });
});

test('the first dialog page has no cursor', async() => {
  const requests: any[] = [];
  const {manager} = createManager({offsetDate: 0, requests, pages: [[]]});

  await manager.getTopMessages({limit: 100, folderId: 0, filterType: FilterType.Folder});

  expect(requests[0]).toMatchObject({offset_id: 0, offset_peer: {_: 'inputPeerEmpty'}});
});

test('a page that repeats its requested cursor ends the list', async() => {
  const requests: any[] = [];
  const {manager, setDialogsLoaded} = createManager({
    cursor: {peerId: 7, id: 300},
    offsetDate: 1000,
    requests,
    pages: [[createDialog(7, 300)]]
  });

  const result = await manager.getTopMessages({limit: 100, folderId: undefined, filterType: FilterType.Folder});

  expect(requests).toHaveLength(1);
  expect(result.isEnd).toBe(true);
  expect(setDialogsLoaded).toHaveBeenCalledWith(undefined, true, FilterType.Folder);
});
