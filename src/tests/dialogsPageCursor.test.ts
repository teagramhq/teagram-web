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

function createManager(options: {
  cursor?: Cursor,
  offsetDate: number,
  requests: any[],
  pages: any[][],
  persisted?: Cursor[]
}) {
  const log = Object.assign(vi.fn(), {bindPrefix: () => log, error: vi.fn()});
  const setDialogsLoaded = vi.fn();
  let cursor = options.cursor;
  const storage = {
    getOffsetDate: () => options.offsetDate,
    getOffsetCursor: () => cursor,
    setOffsetCursor: vi.fn((_folderId: number, nextCursor: Cursor) => {
      cursor = nextCursor;
      options.persisted?.push(nextCursor);
    }),
    getDialogPeerId: (dialog: any) => dialog.peerId,
    isVirtualFilter: () => false,
    filterDialogsForStorage: (dialogs: any[]) => dialogs,
    saveDialog: vi.fn(),
    getFolderDialogs: (): any[] => [],
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

test('uses the persisted server cursor when cached dialogs contain an older outlier', () => {
  const storage = createStorage([
    createDialog(1, 900, {pFlags: {pinned: true}}),
    createDialog(2, 500),
    createDialog(3, 100)
  ], {peerId: 2, id: 500});

  expect(storage.getOffsetCursor(undefined)).toEqual({peerId: 2, id: 500});
});

test('writes cursor updates to account state', () => {
  const storage = createStorage();
  const cursor = {peerId: 8, id: 0};
  (storage as any).dialogsOffsetCursors = undefined;

  expect(storage.getOffsetCursor(undefined)).toBeUndefined();

  storage.setOffsetCursor(undefined, cursor);

  expect(storage.appStateManager.pushToState).toHaveBeenCalledWith('dialogsOffsetCursors', {undefined: cursor});
  expect(storage.getOffsetCursor(undefined)).toEqual(cursor);
});

test('persists the last raw page entry, including the peer tie-breaker for equal IDs', async() => {
  const requests: any[] = [];
  const persisted: Cursor[] = [];
  const {manager, storage} = createManager({
    cursor: {peerId: 7, id: 300},
    offsetDate: 1000,
    requests,
    persisted,
    pages: [[createDialog(8, 200), createDialog(11, 200)]]
  });

  await manager.getTopMessages({limit: 100, folderId: undefined, filterType: FilterType.Folder});

  expect(requests[0]).toMatchObject({offset_id: 300, offset_peer: {_: 'inputPeerUser', user_id: 7}});
  expect(storage.setOffsetCursor).toHaveBeenCalledWith(undefined, {peerId: 11, id: 200});
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
    pages: [[createDialog(8, 0)], [createDialog(9, 0)]]
  });
  const options = {limit: 100, folderId: undefined as number, filterType: FilterType.Folder};

  await manager.getTopMessages(options);
  await manager.getTopMessages(options);

  expect(persisted).toEqual([{peerId: 8, id: 0}, {peerId: 9, id: 0}]);
  expect(requests[1]).toMatchObject({offset_id: 0, offset_peer: {_: 'inputPeerUser', user_id: 8}});
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
