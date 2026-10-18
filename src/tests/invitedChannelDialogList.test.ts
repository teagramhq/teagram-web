import {describe, expect, it, vi} from 'vitest';

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
import '@helpers/peerIdPolyfill';

type ChannelMembership = 'active' | 'left' | 'kicked' | 'forbidden';

const createList = (membership: ChannelMembership = 'active') => {
  const canSaveEmptyChannelDialog = vi.fn(async(_peerId: PeerId, _dialog: Dialog) => membership === 'active');
  const mirroredPeer = membership === 'forbidden' ?
    {_:'channelForbidden', id: 990020} :
    {_:'channel', id: 990020, pFlags: membership === 'left' ? {left: true} : membership === 'kicked' ? {kicked: true} : {}};
  (apiManagerProxy as any).getPeer.mockReturnValue(mirroredPeer);
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
    managers: {dialogsStorage: {canSaveEmptyChannelDialog}},
    getCollapsedCommunityId: vi.fn(() => undefined),
    testDialogForFilter: vi.fn(() => true)
  });

  return {list, sortedList, canSaveEmptyChannelDialog};
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

describe('invited channel dialog rows', () => {
  it('adds an empty invited channel older than the loaded page', () => {
    const peerId = (990020 as ChatId).toPeerId(true);
    const dialog = createDialog(0);
    const {list, sortedList} = createList();

    list.updateDialog(dialog);

    expect(sortedList.has(peerId)).toBe(true);
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
    'does not restore a stale empty dialog after the user is $membership', async({membership}) => {
      const dialog = createDialog(0);
      const {list, sortedList, canSaveEmptyChannelDialog} = createList(membership);

      await expect(canSaveEmptyChannelDialog(dialog.peerId, dialog)).resolves.toBe(false);
      list.updateDialog(dialog);

      expect(canSaveEmptyChannelDialog).toHaveBeenCalledTimes(1);
      expect(sortedList.has(dialog.peerId)).toBe(false);
    }
  );
});
