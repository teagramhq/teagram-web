import {expect, it, vi} from 'vitest';
import '@lib/polyfill';
import {paintChatPageSnapshot} from '@lib/chatPageSnapshotView';

vi.mock('@environment/webpSupport', () => ({default: false}));
vi.mock('@lib/appImManager', () => ({default: {}}));
vi.mock('@components/sortedDialogList', () => ({default: class {}}));
vi.stubGlobal('IntersectionObserver', class {observe() {} unobserve() {} disconnect() {}});
vi.stubGlobal('Worker', class {addEventListener() {} removeEventListener() {} postMessage() {} terminate() {}});
vi.stubGlobal('fetch', async() => ({text: async() => ''}));

it('replaces the snapshot when the worker first page is committed', async() => {
  document.body.innerHTML = '<div id="page-chats"><div id="chatlist-container"><div id="folders-container"><ul></ul></div></div></div>';
  paintChatPageSnapshot([{peerId: 42 as PeerId, title: 'Old', preview: 'Old message', date: 0, unread: 0, markedUnread: false, muted: false, pinned: false}]);
  const {AutonomousDialogListBase} = await import('@components/autonomousDialogList/base');
  const list = Object.create(AutonomousDialogListBase.prototype);
  const liveList = document.querySelector('#folders-container ul');
  Object.assign(list, {
    appDialogsManager: {isFirstDialogsLoad: false},
    getFilterId: () => 0,
    checkForDialogsPlaceholder: () => {},
    dialogsFetcher: async(): Promise<{dialogs: never[], count: number, isEnd: boolean}> => ({dialogs: [], count: 0, isEnd: true}),
    sortedList: {
      list: liveList,
      addDeferredItems: () => { liveList.append('Live page'); },
      itemsLength: () => 0
    }
  });
  await list.loadDialogsInner({canFinish: () => true});
  expect(document.querySelector('.chat-page-snapshot')).toBeNull();
  expect(document.getElementById('folders-container').textContent).toBe('Live page');
});
