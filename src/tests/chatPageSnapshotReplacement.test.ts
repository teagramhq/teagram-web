import {expect, it, vi} from 'vitest';
import '@lib/polyfill';

vi.mock('@environment/webpSupport', () => ({default: false}));
vi.mock('@lib/appImManager', () => ({default: {}}));
vi.mock('@components/sortedDialogList', () => ({default: class {}}));
vi.stubGlobal('IntersectionObserver', class {observe() {} unobserve() {} disconnect() {}});
vi.stubGlobal('Worker', class {addEventListener() {} removeEventListener() {} postMessage() {} terminate() {}});
vi.stubGlobal('fetch', async() => ({text: async() => ''}));

async function createDialogList(filterId: number) {
  vi.resetModules();
  const {paintChatPageSnapshot} = await import('@lib/chatPageSnapshotView');
  document.body.innerHTML = '<div id="page-chats"><div id="chatlist-container"><div id="folders-container"><ul></ul></div></div></div>';
  paintChatPageSnapshot([{peerId: 42 as PeerId, title: 'Old', preview: 'Old message', date: 0, unread: 0, markedUnread: false, muted: false, pinned: false}]);
  const {AutonomousDialogListBase} = await import('@components/autonomousDialogList/base');
  const list = Object.create(AutonomousDialogListBase.prototype);
  const liveList = document.querySelector('#folders-container ul');
  Object.assign(list, {
    appDialogsManager: {isFirstDialogsLoad: false},
    getFilterId: () => filterId,
    checkForDialogsPlaceholder: () => {},
    dialogsFetcher: async(): Promise<{dialogs: never[], count: number, isEnd: boolean}> => ({dialogs: [], count: 0, isEnd: true}),
    sortedList: {
      list: liveList,
      addDeferredItems: () => { liveList.append('Live page'); },
      itemsLength: () => 0
    }
  });

  return {list, liveList};
}

it('replaces the snapshot when the worker first page is committed', async() => {
  const {list} = await createDialogList(0);
  await list.loadDialogsInner({canFinish: () => true});
  expect(document.querySelector('.chat-page-snapshot')).toBeNull();
  expect(document.getElementById('folders-container').textContent).toBe('Live page');
});

it.each([
  {name: 'a non-All filter', filterId: 1, offsetIndex: 0},
  {name: 'an offset page', filterId: 0, offsetIndex: 1}
])('keeps the snapshot while loading $name', async({filterId, offsetIndex}) => {
  const {list} = await createDialogList(filterId);

  await list.loadDialogsInner({offsetIndex, canFinish: () => true});

  expect(document.querySelector('.chat-page-snapshot')).not.toBeNull();
  expect(document.getElementById('folders-container').textContent).toBe('Live page');
});
