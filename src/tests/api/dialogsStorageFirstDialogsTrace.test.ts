import {afterEach, expect, test, vi} from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

test('finishes the chat-list startup span when cached dialogs serve the first page', async() => {
  vi.stubEnv('VITE_PERF_TRACE', '1');
  vi.resetModules();
  const {PerformanceRpcTrace, performancePhaseTrace} = await import('@appManagers/performanceTrace');
  const {ApiManager} = await import('@appManagers/apiManager');
  const {default: DialogsStorage, FilterType} = await import('@lib/storages/dialogs');
  const name = 'worker.chatlist.startToFirstGetDialogs';
  performancePhaseTrace.reset();

  const apiManager = Object.create(ApiManager.prototype) as any;
  apiManager.performanceRpcTrace = new PerformanceRpcTrace(true);
  let finishReconciliation: (result: any) => void;
  apiManager.invokeApiSingleProcess = vi.fn(() => new Promise((resolve) => {
    finishReconciliation = resolve;
  }));

  const dialog = {peerId: 1};
  const storage = Object.create(DialogsStorage.prototype) as any;
  Object.assign(storage, {
    apiManager,
    appPeersManager: {
      isBotforum: () => false,
      saveApiPeers: vi.fn()
    },
    cachedListReconciled: false,
    cachedResults: {query: '', count: 0, dialogs: [], folderId: 0},
    getDialogIndexKeyByFilterId: () => 'index_0',
    getFilterType: () => FilterType.Folder,
    getFolder: () => ({count: 1}),
    getFolderDialogs: () => [dialog],
    getOffsetDate: () => 0,
    isDialogsLoaded: () => false,
    isFilterIdForForum: () => false,
    isVirtualFilter: () => false
  });

  const startedAtEpochMs = performance.timeOrigin + performance.now() - 50;
  apiManager.startFirstDialogsDispatchTrace(startedAtEpochMs);
  const preloaded = storage.getDialogs({filterId: 0, filterType: FilterType.Folder, limit: 1, preload: true});

  expect(preloaded.dialogs).toEqual([dialog]);
  expect(performancePhaseTrace.getSnapshot().find(({name: phaseName}) => phaseName === name)).toMatchObject({
    name,
    durationMs: null
  });
  expect(performancePhaseTrace.getSnapshot().some(({name: phaseName}) => phaseName === 'worker.dialogs.firstPage')).toBe(false);

  const result = storage.getDialogs({filterId: 0, filterType: FilterType.Folder, limit: 1});

  expect(result.dialogs).toEqual([dialog]);
  expect(performancePhaseTrace.getSnapshot().some(({name: phaseName}) => phaseName === 'worker.dialogs.firstPage')).toBe(true);
  expect(apiManager.invokeApiSingleProcess).toHaveBeenCalledOnce();
  expect(performancePhaseTrace.getSnapshot().find(({name: phaseName}) => phaseName === name)).toMatchObject({
    name,
    durationMs: expect.any(Number)
  });

  finishReconciliation({_: 'messages.dialogs', count: 0, dialogs: [], chats: [], users: []});
  await Promise.resolve();
});
