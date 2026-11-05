import {expect, test, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {AppMessagesManager} from '@appManagers/appMessagesManager';
import DialogsStorage, {FilterType} from '@lib/storages/dialogs';

test('dialog page notifications identify the peers saved by that page', async() => {
  const peerId = (-42) as PeerId;
  const dialog = {_: 'dialog', peerId, peer: {_: 'peerChannel', channel_id: 42}, top_message: 0, pFlags: {}};
  const result: any = {_: 'messages.dialogs', dialogs: [dialog], chats: [], users: [], messages: []};
  const dispatchEvent = vi.fn();
  const log = Object.assign(vi.fn(), {bindPrefix: () => log, error: vi.fn()});
  const manager = Object.create(AppMessagesManager.prototype) as any;
  Object.assign(manager, {
    apiManager: {invokeApiSingleProcess: async({processResult}: any) => processResult(result)},
    appPeersManager: {getInputPeerById: vi.fn(), isChannel: () => true},
    appCommunitiesManager: {getCommunityDialogsCount: () => 0},
    appDraftsManager: {addMissedDialogs: vi.fn()},
    dialogsStorage: {
      getOffsetDate: () => 0,
      isVirtualFilter: () => false,
      filterDialogsForStorage: (dialogs: any[]) => dialogs,
      saveDialog: vi.fn(),
      getFolderDialogs: (): any[] => [],
      setDialogsLoaded: vi.fn()
    },
    getChannelAvailableMinIdGeneration: () => 0,
    getMessageByPeer: vi.fn(),
    saveApiResult: vi.fn(),
    middleware: {get: () => () => true},
    rootScope: {dispatchEvent},
    log
  });

  await manager.getTopMessages({limit: 100, folderId: 0, filterType: FilterType.Folder});

  expect(dispatchEvent).toHaveBeenCalledWith('dialogs_multiupdate', new Map(), {reconcilePeerIds: [peerId]});
});

test('peer-dialog updates identify all attempted dialogs for watcher retries', () => {
  const first = (-42) as PeerId;
  const second = (-43) as PeerId;
  const dialogs = [first, second].map((peerId) => ({_: 'dialog', peerId, top_message: 1, pFlags: {}}));
  const result: any = {_: 'messages.peerDialogs', dialogs, messages: [], chats: [], users: []};
  const dispatchEvent = vi.fn();
  const storage = Object.create(DialogsStorage.prototype) as any;
  Object.assign(storage, {
    appMessagesManager: {
      saveApiResult: vi.fn(),
      pendingTopMsgs: {},
      getUpdateAfterReloadKey: (peerId: PeerId) => String(peerId),
      newUpdatesAfterReloadToHandle: {}
    },
    filterDialogsForStorage: vi.fn(),
    getDialogPeerId: (dialog: any) => dialog.peerId,
    saveDialog: vi.fn(({dialog}: any) => dialog.peerId === first),
    rootScope: {dispatchEvent}
  });

  storage.applyDialogs(result);

  expect(dispatchEvent).toHaveBeenCalledWith(
    'dialogs_multiupdate',
    new Map([[first, {dialog: dialogs[0]}]]),
    {reconcilePeerIds: [first, second]}
  );
});
