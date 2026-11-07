import {expect, it, vi} from 'vitest';
import '@lib/polyfill';

const lottieMocks = vi.hoisted(() => ({loadLottieWorkers: vi.fn().mockResolvedValue(undefined)}));
vi.mock('@lib/lottie/lottieLoader', () => ({default: lottieMocks}));

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
  lottieMocks.loadLottieWorkers.mockClear();
  const {list, liveList} = await createDialogList(0);
  lottieMocks.loadLottieWorkers.mockImplementation(() => {
    expect(document.querySelector('.chat-page-snapshot')).toBeNull();
    expect(liveList.textContent).toBe('Live page');
    return Promise.resolve();
  });

  await list.loadDialogsInner({canFinish: () => true});
  expect(document.querySelector('.chat-page-snapshot')).toBeNull();
  expect(document.getElementById('folders-container').textContent).toBe('Live page');
  expect(lottieMocks.loadLottieWorkers).not.toHaveBeenCalled();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(lottieMocks.loadLottieWorkers).toHaveBeenCalledOnce();
});

it.each([
  {name: 'a non-All filter', filterId: 1, offsetIndex: 0},
  {name: 'an offset page', filterId: 0, offsetIndex: 1}
])('keeps the snapshot while loading $name', async({filterId, offsetIndex}) => {
  lottieMocks.loadLottieWorkers.mockClear();
  const {list} = await createDialogList(filterId);

  await list.loadDialogsInner({offsetIndex, canFinish: () => true});

  expect(document.querySelector('.chat-page-snapshot')).not.toBeNull();
  expect(document.getElementById('folders-container').textContent).toBe('Live page');
  expect(lottieMocks.loadLottieWorkers).not.toHaveBeenCalled();
});

it('reports a failed Lottie worker preload', async() => {
  const error = new Error('transient worker startup failure');
  lottieMocks.loadLottieWorkers.mockRejectedValueOnce(error);
  const log = {error: vi.fn()};
  const {list} = await createDialogList(0);
  Object.assign(list, {log});

  await list.loadDialogsInner({canFinish: () => true});
  await vi.waitFor(() => {
    expect(log.error).toHaveBeenCalledWith('Lottie worker preload failed', error);
  });
});
