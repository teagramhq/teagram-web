import {afterEach, expect, test, vi} from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

test('flushes current peers once after the cached-dialog walk completes', async() => {
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
  const firstChat = {_: 'channel', id: 42, title: 'before clear'};
  const firstUser = {_: 'user', id: 1};
  const currentFirstUser = {_: 'user', id: 1, first_name: 'current'};
  const secondUser = {_: 'user', id: 2};
  const currentPeers: Record<string, any> = {};
  const mirroredPeers: Record<string, any> = {'-42': firstChat};
  const storage = Object.create(DialogsStorage.prototype) as any;
  Object.assign(storage, {
    apiManager,
    appPeersManager: {
      isBotforum: () => false,
      getPeerId: (peer: {user_id: number}) => peer.user_id,
      getInputPeerById: (peerId: number) => ({_: 'inputPeerUser', user_id: peerId}),
      saveApiPeers: vi.fn((result: any, _trace: unknown, mirrorBatch?: (peerKey: string, peer: any) => void) => {
        if(typeof mirrorBatch !== 'function') throw new Error('Peer mirror batch callback missing');
        for(const chat of result.chats || []) {
          const peerKey = String(-chat.id);
          currentPeers[peerKey] = chat;
          mirrorBatch(peerKey, chat);
        }
        for(const user of result.users || []) {
          const peerKey = String(user.id);
          currentPeers[peerKey] = user;
          mirrorBatch(peerKey, user);
        }
      }),
      mirrorApiPeers: vi.fn((peerKeys: Iterable<string>, _trace?: 'cachedChannelDialogsReconcile', _traceId?: string) => {
        for(const peerKey of peerKeys) {
          if(currentPeers[peerKey]) mirroredPeers[peerKey] = currentPeers[peerKey];
        }
      })
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
    chats: [firstChat],
    users: [firstUser],
    messages: [{id: 11, peer_id: {_: 'peerUser', user_id: 1}, date: 100}]
  };
  pendingPages[0](firstPage);
  await vi.waitFor(() => expect(pendingPages).toHaveLength(2));
  expect(storage.appPeersManager.mirrorApiPeers).not.toHaveBeenCalled();

  // AppChatsManager.clear removes the peer while the second page is pending.
  delete currentPeers['-42'];
  delete mirroredPeers['-42'];
  currentPeers['1'] = currentFirstUser;

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
      durationMs: expect.any(Number),
      traceId: expect.stringMatching(/^\d+-\d+$/)
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
    new Set(['-42', '1', '2']),
    'cachedChannelDialogsReconcile',
    expect.stringMatching(/^\d+-\d+$/)
  );
  expect(mirroredPeers).toEqual({'1': currentFirstUser, '2': secondUser});
  expect(result.dialogs).toEqual([dialog]);
});
