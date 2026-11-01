import {afterEach, expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => {
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
  Object.defineProperty(window, 'IntersectionObserver', {
    configurable: true,
    value: IntersectionObserverMock
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
    configurable: true,
    value: () => 'data:image/webp;base64,'
  });
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class WorkerMock {}
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}})
  });

  return {
    resolveForumChunk: undefined as (() => void) | undefined,
    history: [] as Array<{peerId?: PeerId}>,
    closeTabsUntilTab: vi.fn(async() => true)
  };
});

vi.mock('@components/forumTab/forumTab', async() => {
  await new Promise<void>((resolve) => {
    mocks.resolveForumChunk = resolve;
  });
  return {ForumTab: class ForumTab {}};
});

vi.mock('@components/forumTab/findForumTabByPeerId', () => ({
  default: (history: Array<{peerId?: PeerId}>, peerId: PeerId) => history.find((tab) => tab.peerId === peerId)
}));
vi.mock('@components/forumTab/communityOpenMode', () => ({default: () => true}));
vi.mock('@appManagers/utils/communities/isCommunity', () => ({default: () => false}));
vi.mock('@components/forumTab/fillRegister', () => ({fillForumTabRegister: vi.fn()}));
vi.mock('@lib/appImManager', () => ({
  default: {chat: undefined, isSamePeer: () => false, setPeer: vi.fn(), setInnerPeer: vi.fn(), selectTab: vi.fn()},
  AppImManager: class AppImManager {},
  APP_TABS: {CHATLIST: 'chatlist'}
}));
vi.mock('@components/sidebarLeft', () => ({
  default: {
    getHistory: vi.fn(() => mocks.history),
    closeSearch: vi.fn(),
    closeTabsUntilTab: mocks.closeTabsUntilTab,
    createTab: vi.fn((Constructor: new() => object) => {
      const tab = new Constructor() as {peerId?: PeerId};
      mocks.history.push(tab);
      return tab;
    })
  }
}));
vi.mock('@components/sidebarRight', () => ({default: {}}));
vi.mock('@lib/apiManagerProxy', () => ({default: {getChat: vi.fn()}}));
vi.mock('@stores/contentSettings', () => ({default: () => ({})}));

import '@helpers/peerIdPolyfill';
import {AppDialogsManager} from '@lib/appDialogsManager';
import type {ForumTab} from '@components/forumTab/forumTab';

const openedPeers: PeerId[] = [];

class TestForumTab {
  public peerId?: PeerId;

  public async open({peerId}: {peerId: PeerId}) {
    this.peerId = peerId;
    const topicList = document.createElement('div');
    topicList.className = 'topics-container';
    topicList.dataset.peerId = '' + peerId;
    document.body.append(topicList);
    openedPeers.push(peerId);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  openedPeers.length = 0;
  mocks.history.length = 0;
  mocks.closeTabsUntilTab.mockClear();
});

test('opens forum topics before and after the deferred forum chunk settles', async() => {
  const peerId = -1001 as PeerId;
  const managers = {
    dialogsStorage: {getDialogOnly: vi.fn(async() => undefined)}
  };
  const manager = Object.create(AppDialogsManager.prototype) as AppDialogsManager;
  Object.assign(manager, {
    forumTabByPeerIdPromises: new Map(),
    managers
  });
  const forumTabConstructor = TestForumTab as unknown as typeof ForumTab;
  const beforeChunkSettles = manager.toggleForumTabByPeerId(peerId, true, false, forumTabConstructor);
  await vi.waitFor(() => expect(mocks.resolveForumChunk).toBeTypeOf('function'));
  expect(document.querySelector('.topics-container')).toBeNull();

  mocks.resolveForumChunk!();
  await beforeChunkSettles;
  expect(document.querySelector(`.topics-container[data-peer-id="${peerId}"]`)).not.toBeNull();

  await manager.toggleForumTabByPeerId(peerId, true, false, forumTabConstructor);
  expect(document.querySelectorAll(`.topics-container[data-peer-id="${peerId}"]`)).toHaveLength(1);
  expect(openedPeers).toEqual([peerId]);
  expect(mocks.closeTabsUntilTab).toHaveBeenCalledWith(expect.objectContaining({peerId}));
});
