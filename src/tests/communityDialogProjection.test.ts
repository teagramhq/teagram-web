vi.mock('@lib/appImManager', () => ({
  default: {}
}));

vi.mock('@lib/appDialogsManager', () => ({
  default: {},
  AppDialogsManager: class {},
  DialogElement: class {}
}));

vi.mock('@components/archiveDialog', () => ({
  default: class {},
  createArchiveDialogState: vi.fn()
}));

vi.mock('@components/communities/communityDialog', () => ({
  createCommunityDialogListElement: vi.fn()
}));

vi.mock('@components/groupCallActiveIcon', () => ({
  default: vi.fn()
}));

vi.mock('@components/scrollable', () => ({
  default: class {}
}));

vi.mock('@components/singleTransition', () => ({
  default: vi.fn()
}));

vi.mock('@components/sortedDialogList', () => ({
  default: class {},
  CustomPinnedDialog: class {},
  CustomSortedDialog: class {}
}));

vi.mock('@environment/groupCallSupport', () => ({
  default: false
}));

vi.mock('@lib/apiManagerProxy', () => ({
  default: {}
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    managers: {},
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }
}));

vi.mock('@lib/solidjs/hotReloadGuardProvider', () => ({
  default: class {}
}));

vi.mock('@lib/solidjs/runWithHotReloadGuard', () => ({
  runWithHotReloadGuard: (callback: () => unknown) => callback()
}));

vi.mock('@stores/communities', () => ({
  useCommunities: () => ({}),
  useCommunityDialogs: () => ({})
}));

vi.hoisted(() => {
  class IntersectionObserverMock {
    public observe() {}
    public unobserve() {}
    public disconnect() {}
    public takeRecords(): IntersectionObserverEntry[] { return []; }
  }

  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: IntersectionObserverMock
  });
});

import {Dialog} from '@appManagers/appMessagesManager';
import {AutonomousDialogListBase} from '@components/autonomousDialogList/base';
import {
  AutonomousDialogList,
  getCommunityProjectionFolderCountDelta
} from '@components/autonomousDialogList/dialogs';
import apiManagerProxy from '@lib/apiManagerProxy';
import {reconcilePeer} from '@stores/peers';
import {FilterType} from '@lib/storages/dialogs';
import DialogsStorage from '@lib/storages/dialogs';
import '@helpers/peerIdPolyfill';

async function createRealSortedList() {
  const {default: SortedDialogList} = await vi.importActual<typeof import('@components/sortedDialogList')>('@components/sortedDialogList');
  return new SortedDialogList({
    appDialogsManager: {} as any, managers: {} as any, indexKey: 'index_0',
    scrollable: {container: document.createElement('div')} as any,
    requestItemForIdx: () => {}, onListShrinked: () => {}, itemSize: 'medium' as any
  });
}

describe('Community dialog projection counts', () => {
  afterEach(() => vi.useRealTimers());

  test('keeps a pending peer pinned in a custom filter', async() => {
    vi.useFakeTimers();
    const sortedList = await createRealSortedList();
    const peerId = (100 as ChatId).toPeerId(true);
    vi.spyOn(sortedList, 'createItemForKey').mockImplementation(async(key) => ({
      id: key, index: 1, value: {type: 'custom-sorted-dialog', value: {render: () => document.createElement('li')}} as any
    }));
    const list = Object.create(AutonomousDialogList.prototype) as any;
    Object.assign(list, {
      sortedList, filterId: 2, filterPinnedPeerIds: new Set([peerId]),
      communityProjectionRows: new Map(), projectedPeerIds: new Set(), projectedPeerFolderIds: new Map()
    });
    const pending = sortedList.add(peerId);
    await list.applyCommunityProjection([{
      communityId: 200 as ChatId, dialogs: [{peerId, folderId: 0, filterIndex: 1}], pinned: false, sortDate: 0
    }], () => true);
    await vi.runAllTimersAsync();
    await pending;
    expect(sortedList.has(peerId)).toBe(true);
    sortedList.destroy();
  });

  test('cancels a queued peer hidden by a community projection', async() => {
    vi.useFakeTimers();
    const sortedList = await createRealSortedList();
    const peerId = (100 as ChatId).toPeerId(true);
    const create = vi.spyOn(sortedList, 'createItemForKey');
    const list = Object.create(AutonomousDialogList.prototype) as any;
    Object.assign(list, {
      sortedList, filterId: 1, filterPinnedPeerIds: new Set(),
      communityProjectionRows: new Map(), projectedPeerIds: new Set(), projectedPeerFolderIds: new Map()
    });
    const pending = sortedList.add(peerId);
    await list.applyCommunityProjection([{
      communityId: 200 as ChatId, dialogs: [{peerId, folderId: 1}], pinned: false, sortDate: 0
    }], () => true);
    await vi.runAllTimersAsync();
    await pending;
    expect(create).not.toHaveBeenCalled();
    expect(sortedList.has(peerId)).toBe(false);
    sortedList.destroy();
  });

  test('cancels an in-flight peer before waiting for its collapsed community row', async() => {
    vi.useFakeTimers();
    const sortedList = await createRealSortedList();
    const peerId = (100 as ChatId).toPeerId(true);
    const laterPeerId = (101 as ChatId).toPeerId(true);
    const communityId = 200 as ChatId;
    const row = {render: () => document.createElement('li')};
    let finishPeer!: (item: any) => void;
    let finishRow!: (item: any) => void;
    const create = vi.spyOn(sortedList, 'createItemForKey').mockImplementation((key) => new Promise((resolve) => {
      if(key === peerId) finishPeer = resolve;
      else finishRow = resolve;
    }));
    const list = Object.create(AutonomousDialogList.prototype) as any;
    Object.assign(list, {
      sortedList, filterId: 0, filterPinnedPeerIds: new Set(),
      communityProjectionRows: new Map(), projectedPeerIds: new Set(), projectedPeerFolderIds: new Map(),
      createCommunityProjectionRow: () => row
    });
    const pendingPeer = sortedList.add(peerId);
    await vi.advanceTimersToNextTimerAsync();
    const projection = list.applyCommunityProjection([{
      communityId, dialogs: [{peerId, folderId: 0}, {peerId: laterPeerId, folderId: 0}], pinned: false, sortDate: 0
    }], () => true);
    await vi.advanceTimersToNextTimerAsync();
    const pendingLaterPeer = sortedList.add(laterPeerId);
    const destroy = vi.fn();
    finishPeer({id: peerId, index: 1, value: {type: 'dialog', value: {destroy}}});
    await pendingPeer;
    const visibleWhileCommunityPending = sortedList.has(peerId);
    const destroyedWhileCommunityPending = destroy.mock.calls.length;
    finishRow({id: row, index: 2, value: {type: 'custom-sorted-dialog', value: row}});
    await projection;
    await vi.runAllTimersAsync();
    await pendingLaterPeer;
    sortedList.destroy();
    expect(visibleWhileCommunityPending).toBe(false);
    expect(destroyedWhileCommunityPending).toBe(1);
    expect(create).not.toHaveBeenCalledWith(laterPeerId);
  });

  test('keeps first-load animations blocked through Community projection', async() => {
    const events: string[] = [];
    const baseLoad = vi.spyOn(
      AutonomousDialogListBase.prototype as any,
      'loadDialogsInner'
    ).mockImplementation(async() => {
      events.push('base-load');
      return {
        cursor: 1,
        count: 1,
        totalCount: 2
      };
    });
    const list = Object.create(AutonomousDialogList.prototype) as any;
    Object.assign(list, {
      sortedList: {
        blockAnimation: () => {
          events.push('block');
          return () => events.push('unblock');
        },
        itemsLength: () => 1
      },
      appDialogsManager: {},
      managers: {dialogsStorage: {getCachedDialogs: vi.fn().mockResolvedValue([])}},
      ensureArchiveDialogHydrated: vi.fn(),
      scheduleCommunityProjection: vi.fn(async() => {
        events.push('projection');
      })
    });
    list.appDialogsManager.xd = list;

    try {
      await expect(list.loadDialogsInner({
        offsetIndex: 0,
        canFinish: () => true
      })).resolves.toMatchObject({totalCount: 1});
      expect(events).toEqual([
        'block',
        'base-load',
        'projection',
        'unblock'
      ]);
    } finally {
      baseLoad.mockRestore();
    }
  });

  test('retries an empty channel row when its peer mirror arrives after the dialog update', async() => {
    const channelId = 12345 as ChatId;
    const peerId = channelId.toPeerId(true);
    const channel = {
      _: 'channel',
      id: channelId,
      pFlags: {megagroup: true}
    };
    const dialog = {
      _: 'dialog',
      peer: {_: 'peerChannel', channel_id: channelId},
      peerId,
      top_message: 0,
      folder_id: 0,
      pFlags: {}
    } as Dialog;
    const list = Object.create(AutonomousDialogList.prototype) as any;
    Object.assign(list, {
      appDialogsManager: {},
      managers: {
        appMessagesManager: {
          getDialogOnly: vi.fn().mockResolvedValue(dialog)
        }
      },
      sortedList: {has: vi.fn().mockReturnValue(false)},
      emptyChannelDialogReconcileDisposers: new Map(),
      emptyChannelDialogReconcilePromises: new Map(),
      emptyChannelDialogReconcileRequested: new Set(),
      emptyChannelDialogReconcileUpdatingDialogs: new Set(),
      emptyChannelDialogReconcileGeneration: 0,
      updateDialog: vi.fn(),
      processDialogForCallStatus: vi.fn()
    });
    list.appDialogsManager.xd = list;
    const proxy = apiManagerProxy as any;
    const originalGetPeer = proxy.getPeer;
    proxy.getPeer = vi.fn().mockReturnValue(channel);
    reconcilePeer(peerId, channel as any);

    try {
      const handleChatUpdate = list.handleChatUpdate;
      expect(handleChatUpdate).toBeTypeOf('function');
      handleChatUpdate.call(list, channelId);

      await vi.waitFor(() => expect(list.managers.appMessagesManager.getDialogOnly).toHaveBeenCalledWith(peerId));
      expect(list.updateDialog).toHaveBeenCalledWith(dialog);
    } finally {
      list.clearEmptyChannelDialogReconciliations();
      reconcilePeer(peerId);
      if(originalGetPeer === undefined) {
        delete proxy.getPeer;
      } else {
        proxy.getPeer = originalGetPeer;
      }
    }
  });

  test.each([true, false])(
    'keeps the normalized ordinary-dialog count when isEnd is %s',
    async(isEnd) => {
    const dialogs = [
      {peerId: 1 as PeerId},
      {peerId: 2 as PeerId}
    ] as Dialog[];
    const folder: {count: number} = {count: null};
    const storage = new DialogsStorage();

    Object.assign(storage as any, {
      appMessagesManager: {
        getTopMessages: vi.fn().mockResolvedValue({
          count: 2,
          isEnd
        })
      },
      appPeersManager: {
        isBotforum: () => false
      },
      cachedResults: {
        count: 0,
        dialogs: [],
        folderId: 0,
        query: ''
      },
      getDialogIndexKeyByFilterId: () => 'index_0',
      getFilterType: () => FilterType.Folder,
      getFolder: () => folder,
      getFolderDialogs: () => dialogs,
      getOffsetDate: () => 0,
      isDialogsLoaded: () => false,
      isFilterIdForForum: () => false,
      isVirtualFilter: () => false
    });

    const result = await storage.getDialogs({limit: 20});

      expect(result.count).toBe(2);
      expect(folder.count).toBe(2);
    }
  );

  test('keeps real-folder counts stable when a hidden chat is archived', () => {
    const peerId = (100 as ChatId).toPeerId(true);
    const previous = new Map<PeerId, number>([[peerId, 0]]);
    const next = new Map<PeerId, number>([[peerId, 1]]);

    expect(getCommunityProjectionFolderCountDelta(previous, next, 0)).toBe(-1);
    expect(getCommunityProjectionFolderCountDelta(previous, next, 1)).toBe(1);
  });

  test('does not alter folder counts for link or collapse transitions', () => {
    const peerId = (100 as ChatId).toPeerId(true);
    const empty = new Map<PeerId, number>();
    const projected = new Map<PeerId, number>([[peerId, 0]]);

    expect(getCommunityProjectionFolderCountDelta(empty, projected, 0)).toBe(0);
    expect(getCommunityProjectionFolderCountDelta(projected, empty, 0)).toBe(0);
  });
});
