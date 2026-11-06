import {expect, test, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {AppMessagesManager} from '@appManagers/appMessagesManager';
import DialogsStorage, {FilterType} from '@lib/storages/dialogs';

function createStorage(dialogs: any[]) {
  const storage = Object.create(DialogsStorage.prototype) as any;
  storage.dialogs = Object.fromEntries(dialogs.map((dialog) => [dialog.peerId, dialog]));
  return storage as DialogsStorage;
}

function createDialog(peerId: number, top_message: number, extra: any = {}) {
  return {_: 'dialog', peerId, peer: {_: 'peerUser', user_id: peerId}, top_message, pFlags: {}, ...extra};
}

test('the next page cursor is the oldest loaded unpinned dialog of the folder', () => {
  const storage = createStorage([
    createDialog(1, 900, {pFlags: {pinned: true}}),
    createDialog(2, 500),
    createDialog(3, 300),
    createDialog(4, 0),
    createDialog(5, 100, {folder_id: 1})
  ]);

  expect(storage.getOffsetCursor(undefined)).toEqual({peerId: 5, id: 100});
  expect(storage.getOffsetCursor(0)).toEqual({peerId: 3, id: 300});
  expect(storage.getOffsetCursor(1)).toEqual({peerId: 5, id: 100});
});

function createManager(options: {cursor?: {peerId: number, id: number}, offsetDate: number, requests: any[]}) {
  const log = Object.assign(vi.fn(), {bindPrefix: () => log, error: vi.fn()});
  const setDialogsLoaded = vi.fn();
  const manager = Object.create(AppMessagesManager.prototype) as any;
  Object.assign(manager, {
    apiManager: {
      invokeApiSingleProcess: async({params, processResult}: any) => {
        options.requests.push(params);
        return processResult({_: 'messages.dialogsSlice', count: 500, dialogs: [], chats: [], users: [], messages: []});
      }
    },
    appPeersManager: {
      getInputPeerById: (peerId: number) => peerId ? {_: 'inputPeerUser', user_id: peerId} : {_: 'inputPeerEmpty'},
      isChannel: () => false
    },
    appCommunitiesManager: {getCommunityDialogsCount: () => 0},
    timeManager: {getServerTimeOffset: () => 0},
    appDraftsManager: {addMissedDialogs: vi.fn()},
    dialogsStorage: {
      getOffsetDate: () => options.offsetDate,
      getOffsetCursor: () => options.cursor,
      isVirtualFilter: () => false,
      filterDialogsForStorage: (dialogs: any[]) => dialogs,
      saveDialog: vi.fn(),
      getFolderDialogs: (): any[] => [],
      setDialogsLoaded
    },
    getChannelAvailableMinIdGeneration: () => 0,
    getMessageByPeer: vi.fn(),
    saveApiResult: vi.fn(),
    middleware: {get: () => () => true},
    rootScope: {dispatchEvent: vi.fn()},
    log
  });
  return {manager, setDialogsLoaded};
}

test('a dialog page after the first carries the server cursor, not only the date', async() => {
  const requests: any[] = [];
  const {manager} = createManager({cursor: {peerId: 7, id: 300}, offsetDate: 1000, requests});

  await manager.getTopMessages({limit: 100, folderId: undefined, filterType: FilterType.Folder});

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({offset_id: 300, offset_peer: {_: 'inputPeerUser', user_id: 7}});
});

test('the first dialog page has no cursor', async() => {
  const requests: any[] = [];
  const {manager} = createManager({offsetDate: 0, requests});

  await manager.getTopMessages({limit: 100, folderId: 0, filterType: FilterType.Folder});

  expect(requests[0]).toMatchObject({offset_id: 0, offset_peer: {_: 'inputPeerEmpty'}});
});

test('a page that did not move the cursor ends the list instead of repeating', async() => {
  const requests: any[] = [];
  const {manager, setDialogsLoaded} = createManager({cursor: {peerId: 7, id: 300}, offsetDate: 1000, requests});
  const options = {limit: 100, folderId: undefined as number, filterType: FilterType.Folder};

  await manager.getTopMessages(options);
  const result = await manager.getTopMessages(options);

  expect(requests).toHaveLength(1);
  expect(result.isEnd).toBe(true);
  expect(setDialogsLoaded).toHaveBeenCalledWith(undefined, true, FilterType.Folder);
});
