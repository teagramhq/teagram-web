import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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

vi.mock('@lib/appImManager', () => ({default: {}}));
vi.mock('@lib/appDialogsManager', () => ({default: {}, AppDialogsManager: class {}, DialogElement: class {}}));
vi.mock('@components/archiveDialog', () => ({default: class {}, createArchiveDialogState: vi.fn()}));
vi.mock('@components/communities/communityDialog', () => ({createCommunityDialogListElement: vi.fn()}));
vi.mock('@components/groupCallActiveIcon', () => ({default: vi.fn()}));
vi.mock('@components/scrollable', () => ({default: class {}}));
vi.mock('@components/singleTransition', () => ({default: vi.fn()}));
vi.mock('@components/sortedDialogList', () => ({default: class {}, CustomPinnedDialog: class {}, CustomSortedDialog: class {}}));
vi.mock('@environment/groupCallSupport', () => ({default: false}));
vi.mock('@lib/apiManagerProxy', () => ({default: {getPeer: vi.fn()}}));
vi.mock('@lib/rootScope', () => ({default: {managers: {}, addEventListener: vi.fn(), dispatchEvent: vi.fn()}}));
vi.mock('@lib/solidjs/hotReloadGuardProvider', () => ({default: class {}}));
vi.mock('@lib/solidjs/runWithHotReloadGuard', () => ({runWithHotReloadGuard: (callback: () => unknown) => callback()}));
vi.mock('@stores/communities', () => ({useCommunities: () => ({}), useCommunityDialogs: () => ({})}));

import type {Dialog} from '@appManagers/appMessagesManager';
import {AutonomousDialogListBase} from '@components/autonomousDialogList/base';
import apiManagerProxy from '@lib/apiManagerProxy';
import {AutonomousDialogList} from '@components/autonomousDialogList/dialogs';
import {reconcilePeer} from '@stores/peers';
import '@helpers/peerIdPolyfill';

type ChannelMembership = 'active' | 'left' | 'kicked' | 'forbidden' | 'unknown';

const lists = new Set<any>();

const createList = (membership: ChannelMembership = 'active') => {
  const mirroredPeer = membership === 'unknown' ?
    undefined :
    membership === 'forbidden' ?
    {_:'channelForbidden', id: 990020} :
    {_:'channel', id: 990020, pFlags: membership === 'left' ? {left: true} : membership === 'kicked' ? {kicked: true} : {}};
  const getPeer = (apiManagerProxy as any).getPeer;
  getPeer.mockReset();
  getPeer.mockReturnValue(mirroredPeer);
  const renderedPeerIds = new Set<PeerId>();
  const sortedList = {
    add: (key: PeerId) => renderedPeerIds.add(key),
    delete: (key: PeerId) => renderedPeerIds.delete(key),
    getDialogElement: (): undefined => undefined,
    getSortedItems: () => [{index: 100}],
    has: (key: PeerId) => renderedPeerIds.has(key)
  };
  const list = Object.create(AutonomousDialogList.prototype) as any;
  Object.assign(list, {
    filterId: 0,
    indexKey: 'index_0',
    hasReachedTheEnd: false,
    sortedList,
    projectedPeerIds: new Set(),
    filterPinnedPeerIds: new Set(),
    managers: {dialogsStorage: {}},
    emptyChannelDialogReconcileDisposers: new Map(),
    emptyChannelDialogReconcilePromises: new Map(),
    emptyChannelDialogReconcileRequested: new Set(),
    emptyChannelDialogReconcileUpdatingDialogs: new Set(),
    emptyChannelDialogReconcileGeneration: 0,
    getCollapsedCommunityId: vi.fn(() => undefined),
    testDialogForFilter: vi.fn(() => true)
  });
  list.appDialogsManager = {xd: list};
  lists.add(list);

  return {list, sortedList};
};

const createDialog = (topMessage: number) => ({
  _: 'dialog',
  peer: {_: 'peerChannel', channel_id: 990020},
  peerId: (990020 as ChatId).toPeerId(true),
  top_message: topMessage,
  folder_id: 0,
  pFlags: {},
  index_0: 1
} as Dialog);

const loadDialogs = async(list: any) => {
  const baseLoad = vi.spyOn(AutonomousDialogListBase.prototype as any, 'loadDialogsInner')
  .mockResolvedValue({cursor: 1, count: 1, totalCount: 0});
  const scheduleProjection = vi.spyOn(list as any, 'scheduleCommunityProjection').mockResolvedValue(undefined);
  list.sortedList.blockAnimation = () => () => {};
  list.sortedList.itemsLength = () => 0;

  try {
    await list.loadDialogsInner({offsetIndex: 0, canFinish: () => true});
  } finally {
    baseLoad.mockRestore();
    scheduleProjection.mockRestore();
  }
};

describe('invited channel dialog rows', () => {
  beforeEach(() => {
    reconcilePeer((990020 as ChatId).toPeerId(true));
  });

  afterEach(() => {
    for(const list of lists) {
      list.clearEmptyChannelDialogReconciliations?.();
    }
    lists.clear();
    reconcilePeer((990020 as ChatId).toPeerId(true));
  });

  it('adds an empty invited channel older than the loaded page', () => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList();

    list.updateDialog(dialog);

    expect(sortedList.has(peerId)).toBe(true);
  });

  it('keeps a channel visible when its first dialog arrives after an empty manager cache', () => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const {list, sortedList} = createList();
    const managerDialogs = new Map<PeerId, Dialog>();

    expect(managerDialogs.get(peerId)).toBeUndefined();
    const firstDialog = createDialog(0);
    managerDialogs.set(peerId, firstDialog);
    list.updateDialog(managerDialogs.get(peerId));

    expect(sortedList.has(peerId)).toBe(true);

    firstDialog.top_message = 1;
    firstDialog.index_0 = 101;
    list.updateDialog(firstDialog);

    expect(sortedList.has(peerId)).toBe(true);
  });

  it('keeps a channel with messages below the loaded page out', () => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const {list, sortedList} = createList();

    list.updateDialog(createDialog(1));

    expect(sortedList.has(peerId)).toBe(false);
  });

  it('reconciles a cached empty channel when peer metadata arrives after list load', async() => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList('unknown');
    list.managers.dialogsStorage = {
      getCachedDialogs: vi.fn().mockResolvedValue([dialog])
    };
    list.managers.appMessagesManager = {
      getDialogOnly: vi.fn().mockResolvedValue(dialog)
    };

    await loadDialogs(list);
    expect(sortedList.has(peerId)).toBe(false);

    const channel = {_:'channel', id: 990020, pFlags: {}} as any;
    (apiManagerProxy as any).getPeer.mockReturnValue(channel);
    reconcilePeer(peerId, channel);

    await vi.waitFor(() => expect(sortedList.has(peerId)).toBe(true));
  });

  it('retries a watched empty dialog after peer metadata arrives before its cache entry', async() => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList('unknown');
    const cache: {dialog?: Dialog} = {};
    list.managers.appMessagesManager = {
      getDialogOnly: vi.fn(() => Promise.resolve(cache.dialog))
    };
    (apiManagerProxy as any).getPeer.mockReturnValue({_:'channel', id: 990020, pFlags: {}});
    reconcilePeer(peerId, {_:'channel', id: 990020, pFlags: {}} as any);

    await list.handleChatUpdate(990020 as ChatId);
    expect(sortedList.has(peerId)).toBe(false);

    cache.dialog = dialog;
    list.managers.dialogsStorage = {
      getCachedDialogs: vi.fn().mockResolvedValue([dialog])
    };
    await loadDialogs(list);

    await vi.waitFor(() => expect(sortedList.has(peerId)).toBe(true));
  });

  it('fetches a missing empty dialog after active channel membership arrives', async() => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList('unknown');
    let cachedDialog: Dialog | undefined;
    const reloadConversation = vi.fn(async() => {
      cachedDialog = dialog;
      return dialog;
    });
    list.managers.appMessagesManager = {
      getDialogOnly: vi.fn(() => Promise.resolve(cachedDialog)),
      reloadConversation
    };
    const channel = {_:'channel', id: 990020, pFlags: {}} as any;
    (apiManagerProxy as any).getPeer.mockReturnValue(channel);
    reconcilePeer(peerId, channel);

    await list.handleChatUpdate(990020 as ChatId);

    await vi.waitFor(() => expect(sortedList.has(peerId)).toBe(true));
    expect(reloadConversation).toHaveBeenCalledExactlyOnceWith(peerId);
  });

  it('restores a dialog skipped before its active peer mirror arrives', async() => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList('unknown');
    list.managers.appMessagesManager = {
      getDialogOnly: vi.fn().mockResolvedValue(dialog)
    };

    list.updateDialog(dialog);
    expect(sortedList.has(peerId)).toBe(false);

    const channel = {_:'channel', id: 990020, pFlags: {}} as any;
    (apiManagerProxy as any).getPeer.mockReturnValue(channel);
    reconcilePeer(peerId, channel);

    await vi.waitFor(() => expect(sortedList.has(peerId)).toBe(true));
  });

  it.each([
    {membership: 'left' as const},
    {membership: 'kicked' as const},
    {membership: 'forbidden' as const}
  ])(
    'does not restore a stale empty dialog after the user is $membership', ({membership}) => {
      const dialog = createDialog(0);
      const {list, sortedList} = createList(membership);

      list.updateDialog(dialog);

      expect(sortedList.has(dialog.peerId)).toBe(false);
      expect((apiManagerProxy as any).getPeer).toHaveBeenCalledWith(dialog.peerId);
    }
  );
});
