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
  const pendingPages: Array<(result: any) => void> = [];
  apiManager.invokeApiSingleProcess = vi.fn(({processResult}: {processResult?: (result: any) => any}) => new Promise<any>((resolve) => {
    pendingPages.push((result) => resolve(processResult ? processResult(result) : result));
  }));

  const dialog = {peerId: 1};
  const firstUser = {_: 'user', id: 1};
  const secondUser = {_: 'user', id: 2};
  const mirroredPeers: Record<string, any> = {};
  const storage = Object.create(DialogsStorage.prototype) as any;
  Object.assign(storage, {
    apiManager,
    appPeersManager: {
      isBotforum: () => false,
      getPeerId: (peer: {user_id: number}) => peer.user_id,
      getInputPeerById: (peerId: number) => ({_: 'inputPeerUser', user_id: peerId}),
      saveApiPeers: vi.fn((result: any, _trace: unknown, mirrorBatch?: (peerKey: string, peer: any) => void) => {
        if(typeof mirrorBatch !== 'function') throw new Error('Peer mirror batch callback missing');
        for(const user of result.users || []) {
          mirrorBatch(String(user.id), user);
        }
      }),
      mirrorApiPeers: vi.fn((peers: Record<string, any>) => Object.assign(mirroredPeers, peers))
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
  const result = storage.getDialogs({filterId: 0, filterType: FilterType.Folder, limit: 1, offsetIndex: 0});

  expect(result.dialogs).toEqual([dialog]);
  expect(performancePhaseTrace.getSnapshot().find(({name: phaseName}) => phaseName === name)).toMatchObject({
    name,
    durationMs: expect.any(Number)
  });
  expect(performancePhaseTrace.getSnapshot().some(({name: phaseName}) => phaseName === 'worker.dialogs.firstPage')).toBe(false);

  const firstPage: any = {
    _: 'messages.dialogsSlice',
    count: 2,
    dialogs: [{_: 'dialog', peer: {_: 'peerUser', user_id: 1}, top_message: 11}],
    chats: [],
    users: [firstUser],
    messages: [{id: 11, peer_id: {_: 'peerUser', user_id: 1}, date: 100}]
  };
  pendingPages[0](firstPage);
  await vi.waitFor(() => expect(pendingPages).toHaveLength(2));
  expect(storage.appPeersManager.mirrorApiPeers).not.toHaveBeenCalled();

  const secondPage: any = {
    _: 'messages.dialogs',
    count: 2,
    dialogs: [{_: 'dialog', peer: {_: 'peerUser', user_id: 2}, top_message: 22}],
    chats: [],
    users: [secondUser],
    messages: []
  };
  pendingPages[1](secondPage);
  await vi.waitFor(() => {
    expect(performancePhaseTrace.getSnapshot().find(({name: phaseName}) => phaseName === 'worker.dialogs.cachedChannelReconcile')).toMatchObject({
      pageCount: 2,
      durationMs: expect.any(Number)
    });
  });

  const saveApiPeers = storage.appPeersManager.saveApiPeers;
  expect(saveApiPeers).toHaveBeenNthCalledWith(
    1,
    firstPage,
    'cachedChannelDialogsReconcile',
    expect.any(Function)
  );
  expect(saveApiPeers).toHaveBeenNthCalledWith(
    2,
    secondPage,
    'cachedChannelDialogsReconcile',
    expect.any(Function)
  );
  expect(saveApiPeers.mock.calls[1][2]).toBe(saveApiPeers.mock.calls[0][2]);
  expect(storage.appPeersManager.mirrorApiPeers).toHaveBeenCalledTimes(1);
  expect(storage.appPeersManager.mirrorApiPeers).toHaveBeenCalledWith(
    {'1': firstUser, '2': secondUser},
    'cachedChannelDialogsReconcile'
  );
  expect(mirroredPeers).toEqual({'1': firstUser, '2': secondUser});
  expect(result.dialogs).toEqual([dialog]);
});
