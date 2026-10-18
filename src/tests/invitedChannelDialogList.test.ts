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
    emptyChannelDialogReconcileDisposers: new Map(),
    emptyChannelDialogReconcilePromises: new Map(),
    emptyChannelDialogReconcileRequested: new Set(),
    emptyChannelDialogReconcileUpdatingDialogs: new Set(),
    emptyChannelDialogReconcileGeneration: 0,
    managers: {dialogsStorage: {}},
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

const createChannelPeer = () => ({
  _: 'channel',
  id: 990020,
  pFlags: {}
} as any);

describe('invited channel dialog rows', () => {
  beforeEach(() => {
    reconcilePeer((990020 as ChatId).toPeerId(true));
  });

  afterEach(() => {
    for(const list of lists) {
      list.clearEmptyChannelDialogReconciliations();
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

  it('adds an invited channel when its chat metadata arrives after the dialog update', async() => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList('unknown');
    list.managers.appMessagesManager = {getDialogOnly: vi.fn().mockResolvedValue(dialog)};
    list.managers.appChatsManager = {getChat: vi.fn().mockResolvedValue(createChannelPeer())};

    list.updateDialog(dialog);
    expect(sortedList.has(peerId)).toBe(false);

    (apiManagerProxy as any).getPeer.mockReturnValue({_:'channel', id: 990020, pFlags: {}});
    reconcilePeer(peerId, createChannelPeer());
    await (list as any).onChatUpdate(990020 as ChatId);

    await vi.waitFor(() => expect(sortedList.has(peerId)).toBe(true));
  });

  it('reconciles an empty channel when metadata arrives before its dialog', async() => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList('unknown');
    const cache: {dialog?: Dialog} = {};
    list.managers.appMessagesManager = {
      getDialogOnly: vi.fn(() => Promise.resolve(cache.dialog))
    };
    list.managers.appChatsManager = {
      getChat: vi.fn().mockResolvedValue(createChannelPeer())
    };
    reconcilePeer(peerId, createChannelPeer());
    (apiManagerProxy as any).getPeer.mockReturnValue(createChannelPeer());

    await (list as any).onChatUpdate(990020 as ChatId);
    await vi.waitFor(() => expect(list.managers.appMessagesManager.getDialogOnly).toHaveBeenCalled());
    expect(sortedList.has(peerId)).toBe(false);

    cache.dialog = dialog;
    (list as any).reconcileWatchedEmptyChannelDialogs();

    await vi.waitFor(() => expect(sortedList.has(peerId)).toBe(true));
  });

  it('reconciles an empty channel when its dialog arrives before the peer mirror', async() => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList('unknown');
    list.managers.appMessagesManager = {
      getDialogOnly: vi.fn().mockResolvedValue(dialog)
    };

    list.updateDialog(dialog);
    await vi.waitFor(() => expect(sortedList.has(peerId)).toBe(false));

    reconcilePeer(peerId, createChannelPeer());
    (apiManagerProxy as any).getPeer.mockReturnValue(createChannelPeer());

    await vi.waitFor(() => expect(sortedList.has(peerId)).toBe(true));
  });

  it('restores an empty invited channel cached before the dialog list was created', async() => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList();
    reconcilePeer(peerId, createChannelPeer());
    list.managers.dialogsStorage = {
      getCachedDialogs: vi.fn().mockResolvedValue([dialog])
    };
    list.managers.appMessagesManager = {
      getDialogOnly: vi.fn().mockResolvedValue(dialog)
    };

    await (list as any).reconcileCachedEmptyChannelDialogs();

    expect(sortedList.has(peerId)).toBe(true);
  });

  it('waits for the peer mirror before restoring a cached empty channel', async() => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList('unknown');
    list.managers.dialogsStorage = {
      getCachedDialogs: vi.fn().mockResolvedValue([dialog])
    };
    list.managers.appMessagesManager = {
      getDialogOnly: vi.fn().mockResolvedValue(dialog)
    };
    const updateDialog = vi.spyOn(list, 'updateDialog');

    await (list as any).reconcileCachedEmptyChannelDialogs();

    expect(sortedList.has(peerId)).toBe(false);
    expect(updateDialog).not.toHaveBeenCalled();

    reconcilePeer(peerId, createChannelPeer());
    (apiManagerProxy as any).getPeer.mockReturnValue(createChannelPeer());

    await vi.waitFor(() => expect(sortedList.has(peerId)).toBe(true));
  });

  it('keeps a channel with messages below the loaded page out', () => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const {list, sortedList} = createList();

    list.updateDialog(createDialog(1));

    expect(sortedList.has(peerId)).toBe(false);
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
