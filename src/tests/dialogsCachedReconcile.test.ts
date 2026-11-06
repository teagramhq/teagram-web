import {expect, test, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import type DialogsStorage from '@lib/storages/dialogs';

test('reloads missing cached dialogs in bounded worker batches', async() => {
  const peerIds = Array.from({length: 60}, (_, index) => -(index + 1) as PeerId);
  let activeReloads = 0;
  let maxActiveReloads = 0;
  const reloadConversation = vi.fn(async() => {
    ++activeReloads;
    maxActiveReloads = Math.max(maxActiveReloads, activeReloads);
    await Promise.resolve();
    --activeReloads;
  });
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    appMessagesManager: {reloadConversation},
    appChatsManager: {isInChat: () => false},
    cachedListReconciled: false,
    getDialogOnly: (): undefined => undefined,
    getServerChannelsMissingLocally: async() => peerIds
  });

  await storage.reconcileCachedChannelDialogs();

  expect(reloadConversation).toHaveBeenCalledTimes(peerIds.length);
  expect(maxActiveReloads).toBeLessThanOrEqual(25);
});

test('retries failed peer batches with bounded backoff and without rewalking the server list', async() => {
  vi.useFakeTimers();
  try {
    const firstPeerId = -1 as PeerId;
    const secondPeerId = -2 as PeerId;
    const loadedPeerIds = new Set<PeerId>();
    const reloadAttempts = new Map<PeerId, number>();
    const reloadedPeerIds: PeerId[] = [];
    const reloadConversation = vi.fn(async(peerId: PeerId) => {
      reloadedPeerIds.push(peerId);
      const attempt = (reloadAttempts.get(peerId) || 0) + 1;
      reloadAttempts.set(peerId, attempt);
      if(peerId === firstPeerId && attempt > 1 && attempt < 9) {
        throw new Error(attempt === 2 ? 'retry batch failed' : 'peer still unavailable');
      }
      if((peerId === firstPeerId && attempt === 9) || (peerId === secondPeerId && attempt === 2)) {
        loadedPeerIds.add(peerId);
      }
    });
    const getServerChannelsMissingLocally = vi.fn(async() => [firstPeerId, secondPeerId]);
    const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
    Object.assign(storage, {
      appMessagesManager: {reloadConversation},
      appChatsManager: {isInChat: () => true},
      cachedListReconciled: false,
      getDialogOnly: (peerId: PeerId): {} | undefined => loadedPeerIds.has(peerId) ? {} : undefined,
      getServerChannelsMissingLocally,
      log: {error: vi.fn()}
    });

    await storage.reconcileCachedChannelDialogs();
    expect(reloadedPeerIds).toEqual([firstPeerId, secondPeerId]);

    await vi.advanceTimersByTimeAsync(250);
    expect(reloadedPeerIds).toEqual([firstPeerId, secondPeerId, firstPeerId, secondPeerId]);
    expect(storage.cachedListReconcileRetryPeerIds).toEqual([firstPeerId]);

    await vi.advanceTimersByTimeAsync(499);
    expect(reloadedPeerIds).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(reloadedPeerIds).toHaveLength(5);

    for(const [delay, expectedCount] of [[999, 5], [1_999, 6], [3_999, 7], [7_999, 8], [15_999, 9]] as const) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(reloadedPeerIds).toHaveLength(expectedCount);
      await vi.advanceTimersByTimeAsync(1);
      expect(reloadedPeerIds).toHaveLength(expectedCount + 1);
    }

    await vi.advanceTimersByTimeAsync(29_999);
    expect(reloadedPeerIds).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1);

    expect(reloadedPeerIds).toEqual([
      firstPeerId,
      secondPeerId,
      firstPeerId,
      secondPeerId,
      firstPeerId,
      firstPeerId,
      firstPeerId,
      firstPeerId,
      firstPeerId,
      firstPeerId,
      firstPeerId
    ]);
    expect(getServerChannelsMissingLocally).toHaveBeenCalledTimes(1);
    expect(storage.cachedListReconcileRetryPeerIds).toBeUndefined();
    expect(storage.cachedListReconciled).toBe(true);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test('mirrors each reconciliation page before delivering its peer events', async() => {
  const pages: any[] = [
    {
      _: 'messages.dialogsSlice',
      count: 2,
      dialogs: [{_: 'dialog', peer: {_: 'peerChannel', id: 42}, top_message: 100}],
      messages: [],
      chats: [{_: 'channel', id: 42}]
    },
    {
      _: 'messages.dialogsSlice',
      count: 2,
      dialogs: [{_: 'dialog', peer: {_: 'peerChannel', id: 43}, top_message: 200}],
      messages: [],
      chats: [{_: 'channel', id: 43}]
    }
  ];
  const mirrorApiPeers = vi.fn();
  let capturedEvents: any[];
  const saveApiPeers = vi.fn((result: any, _trace: unknown, mirrorBatch: any) => {
    result.chats.forEach((chat: any) => {
      mirrorBatch('' + (-chat.id), chat);
      capturedEvents.push({name: 'chat_update', args: [chat.id]});
      capturedEvents.push({name: 'user_update', args: [chat.id + 100]});
    });
  });
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    apiManager: {
      invokeApiSingleProcess: vi.fn(async({processResult}: any) => {
        const result = pages.shift();
        processResult(result);
        return result;
      })
    },
    appPeersManager: {
      getPeerId: ({id}: {id: number}) => id,
      getInputPeerById: () => ({_: 'inputPeerEmpty'}),
      saveApiPeers,
      mirrorApiPeers
    },
    rootScope: {collectBroadcastEvents: (events: any[], callback: () => void) => {
      capturedEvents = events;
      callback();
    }},
    appChatsManager: {isInChat: vi.fn()},
    cachedListReconciled: false,
    getDialogOnly: () => ({})
  });

  await storage.getServerChannelsMissingLocally();

  const calls = mirrorApiPeers.mock.calls;
  expect(calls[0][0]).toEqual(['-42']);
  expect(calls[0][6]).toEqual([42]);
  expect(calls[1][5]).toEqual([{name: 'chat_update', args: [42]}, {name: 'user_update', args: [142, {statusFromWorker: true}]}]);
  expect(calls[2][0]).toEqual(['-43']);
  expect(calls[3][5]).toEqual([{name: 'chat_update', args: [43]}, {name: 'user_update', args: [143, {statusFromWorker: true}]}]);
});

test('splits large pages into bounded mirror and notification tasks', async() => {
  const chats = Array.from({length: 25}, (_, index) => ({_: 'channel', id: index + 1}));
  const page: any = {_: 'messages.dialogs', chats, dialogs: [], messages: []};
  let capturedEvents: any[];
  const mirrorApiPeers = vi.fn();
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    rootScope: {collectBroadcastEvents: (events: any[], callback: () => void) => {
      capturedEvents = events;
      callback();
    }},
    apiManager: {invokeApiSingleProcess: async({processResult}: any) => processResult(page)},
    appPeersManager: {
      saveApiPeers: (result: any, _trace: unknown, mirrorBatch: any) => result.chats.forEach((chat: any) => {
        mirrorBatch(String((-chat.id) as PeerId), chat);
        capturedEvents.push({name: 'chat_update', args: [chat.id]});
      }),
      mirrorApiPeers
    },
    appChatsManager: {isInChat: vi.fn()},
    getDialogOnly: () => ({})
  });

  await storage.getServerChannelsMissingLocally();

  const calls = mirrorApiPeers.mock.calls;
  const mirrorCalls = calls.filter((call) => call[0].length);
  const eventCalls = calls.filter((call) => call[5]?.length);
  expect(mirrorCalls.map((call) => call[0].length)).toEqual([4, 4, 4, 4, 4, 4, 1]);
  expect(eventCalls.map((call) => call[5].length)).toEqual([4, 4, 4, 4, 4, 4, 1]);
  expect(eventCalls.flatMap((call) => call[5].map((event: any) => event.args[0]))).toEqual(chats.map((chat) => chat.id));
  mirrorCalls.forEach((call) => expect(call[6]).toEqual(call[0].map((key: string) => -Number(key))));
});

test('keeps every mirror and notification task of a 100-peer page within the batch bound', async() => {
  const chats = Array.from({length: 100}, (_, index) => ({_: 'channel', id: index + 1}));
  const page: any = {_: 'messages.dialogs', chats, dialogs: [], messages: []};
  let capturedEvents: any[];
  const mirrorApiPeers = vi.fn();
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    rootScope: {collectBroadcastEvents: (events: any[], callback: () => void) => {
      capturedEvents = events;
      callback();
    }},
    apiManager: {invokeApiSingleProcess: async({processResult}: any) => processResult(page)},
    appPeersManager: {
      saveApiPeers: (result: any, _trace: unknown, mirrorBatch: any) => result.chats.forEach((chat: any) => {
        mirrorBatch(String((-chat.id) as PeerId), chat);
        capturedEvents.push({name: 'chat_update', args: [chat.id]}, {name: 'user_update', args: [chat.id]});
      }),
      mirrorApiPeers
    },
    appChatsManager: {isInChat: vi.fn()},
    getDialogOnly: () => ({})
  });

  await storage.getServerChannelsMissingLocally();

  const calls = mirrorApiPeers.mock.calls;
  const mirrorCalls = calls.filter((call) => call[0].length);
  const eventCalls = calls.filter((call) => call[5]?.length);
  const bound = 4;
  mirrorCalls.forEach((call) => expect(call[0].length).toBeLessThanOrEqual(bound));
  eventCalls.forEach((call) => expect(call[5].length).toBeLessThanOrEqual(bound));
  expect(mirrorCalls.reduce((total, call) => total + call[0].length, 0)).toBe(100);
  expect(eventCalls.reduce((total, call) => total + call[5].length, 0)).toBe(200);
  expect(mirrorCalls).toHaveLength(25);
});

test('marks captured user updates for synchronous status reads', async() => {
  const page: any = {_: 'messages.dialogs', users: [{_: 'user', id: 7}], dialogs: [], messages: []};
  let capturedEvents: any[];
  const mirrorApiPeers = vi.fn();
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    rootScope: {collectBroadcastEvents: (events: any[], callback: () => void) => {
      capturedEvents = events;
      callback();
    }},
    apiManager: {invokeApiSingleProcess: async({processResult}: any) => processResult(page)},
    appPeersManager: {
      saveApiPeers: (result: any, _trace: unknown, mirrorBatch: any) => {
        mirrorBatch('7', result.users[0]);
        capturedEvents.push({name: 'user_update', args: [7]}, {name: 'user_update', args: [8]});
      },
      mirrorApiPeers
    },
    appChatsManager: {isInChat: vi.fn()},
    getDialogOnly: () => ({})
  });

  await storage.getServerChannelsMissingLocally();

  expect(mirrorApiPeers.mock.calls[1][5]).toEqual([
    {name: 'user_update', args: [7, {statusFromWorker: true}]},
    {name: 'user_update', args: [8, {statusFromWorker: true}]}
  ]);
});

test('a failed second page keeps first-page updates and allows a retry', async() => {
  const failure = new Error('second page failed');
  const page: any = {_: 'messages.dialogsSlice', count: 2, dialogs: [
    {_: 'dialog', peer: {_: 'peerChannel', id: 42}, top_message: 1}
  ], messages: [], chats: [{_: 'channel', id: 42}]};
  let capturedEvents: any[];
  const mirrorApiPeers = vi.fn();
  const invokeApiSingleProcess = vi.fn()
  .mockImplementationOnce(async({processResult}: any) => processResult(page))
  .mockRejectedValueOnce(failure)
  .mockImplementationOnce(async({processResult}: any) => processResult({_: 'messages.dialogs', dialogs: [], messages: [], chats: []}));
  const log = {error: vi.fn()};
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    log,
    rootScope: {collectBroadcastEvents: (events: any[], callback: () => void) => { capturedEvents = events; callback(); }},
    apiManager: {invokeApiSingleProcess},
    appPeersManager: {
      saveApiPeers: (result: any, _trace: unknown, mirrorBatch: any) => result.chats.forEach((chat: any) => {
        mirrorBatch(String(-chat.id), chat);
        capturedEvents.push({name: 'chat_update', args: [chat.id]});
      }),
      getPeerId: ({id}: any) => id,
      getInputPeerById: () => ({_: 'inputPeerEmpty'}),
      mirrorApiPeers
    },
    appChatsManager: {isInChat: () => false},
    cachedListReconciled: false,
    getDialogOnly: () => ({})
  });

  await storage.reconcileCachedChannelDialogs();
  expect(mirrorApiPeers.mock.calls.some((call) => call[0].includes('-42'))).toBe(true);
  expect(mirrorApiPeers.mock.calls.some((call) => call[5]?.some((event: any) => event.name === 'chat_update'))).toBe(true);
  expect(log.error).toHaveBeenCalledWith('cached channel dialog reconcile failed', failure);
  expect(storage.cachedListReconciled).toBe(false);
  expect(storage.cachedListReconcileRetryTimeout).toBeDefined();
  clearTimeout(storage.cachedListReconcileRetryTimeout);
  storage.cachedListReconcileRetryTimeout = undefined;
  await storage.reconcileCachedChannelDialogs();
  expect(invokeApiSingleProcess).toHaveBeenCalledTimes(3);
  expect(storage.cachedListReconciled).toBe(true);
});

test('a failing final flush preserves the original walk error', async() => {
  const failure = new Error('walk failed');
  const flushFailure = new Error('flush failed');
  const log = {error: vi.fn()};
  vi.stubEnv('VITE_PERF_RECONCILE_TRACE', '1');
  const {performancePhaseTrace} = await import('@appManagers/performanceTrace');
  const finishTrace = vi.fn();
  const startTrace = vi.spyOn(performancePhaseTrace, 'start').mockReturnValue(finishTrace);
  const storage = Object.create((await import('@lib/storages/dialogs')).default.prototype) as DialogsStorage & any;
  Object.assign(storage, {
    log,
    rootScope: {collectBroadcastEvents: (events: any[], callback: () => void) => callback()},
    apiManager: {invokeApiSingleProcess: async({processResult}: any) => {
      processResult({_: 'messages.dialogs', chats: [], users: [], dialogs: [], messages: []});
      throw failure;
    }},
    appPeersManager: {
      saveApiPeers: (_result: any, _trace: unknown, mirrorBatch: any) => mirrorBatch('-42', {}),
      mirrorApiPeers: vi.fn().mockImplementationOnce(() => { throw flushFailure; })
    }
  });
  try {
    await expect(storage.getServerChannelsMissingLocally()).rejects.toBe(failure);
    expect(log.error).toHaveBeenCalledWith('cached channel dialog reconcile flush failed', flushFailure);
    expect(finishTrace).toHaveBeenCalledWith({pageCount: 0});
  } finally {
    startTrace.mockRestore();
    vi.unstubAllEnvs();
  }
});
