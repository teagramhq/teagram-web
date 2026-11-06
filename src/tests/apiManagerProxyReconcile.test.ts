import {afterEach, expect, test, vi} from 'vitest';
import rootScope from '@lib/rootScope';

vi.mock('@lib/accounts/getCurrentAccount', () => ({getCurrentAccount: () => 1}));
vi.mock('@environment/webpSupport', () => ({default: true}));
vi.mock('@helpers/setWorkerProxy', () => ({makeWorkerURL: (url: string) => new URL(url, location.href)}));
vi.mock('@components/animationIntersector', () => ({default: {}}));
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
vi.stubGlobal('Worker', class Worker extends EventTarget {
  postMessage() {}
  terminate() {}
});
vi.stubGlobal('fetch', () => new Promise(() => {}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('a mirror from another account dispatches only common events', async() => {
  const proxy = (await import('@lib/apiManagerProxy')).default as any;
  const dispatch = vi.spyOn(rootScope, 'dispatchEventSingle').mockImplementation(() => {});
  const peers = proxy.mirrors.peers;
  const before = {...peers};
  proxy.onMirrorTask({
    name: 'peers', accountNumber: 2, merge: true, value: {'-42': {_: 'channel', id: 42}},
    events: [
      {name: 'chat_update', args: [42]},
      {name: 'user_update', args: [7]},
      {name: 'language_change', args: ['en']}
    ]
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledWith('language_change', 'en');
  expect(peers).toEqual(before);
});

test('logs trace storage failures instead of silently losing evidence', async() => {
  vi.stubEnv('VITE_PERF_RECONCILE_TRACE', '1');
  const proxy = (await import('@lib/apiManagerProxy')).default as any;
  const error = new Error('storage unavailable');
  const log = vi.spyOn(proxy.log, 'error').mockImplementation(() => {});
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw error; });
  (globalThis as any).__teagramPerf = {cachedDialogsReconcileMainThreadMsByTraceId: {}};
  try {
    proxy.onMirrorTask({name: 'peers', accountNumber: 1, traceOnly: true, trace: 'cachedChannelDialogsReconcile', traceId: 'trace'});
    expect(log).toHaveBeenCalledWith('cached dialog reconcile trace storage read failed', error);
  } finally {
    delete (globalThis as any).__teagramPerf;
  }
});

test('logs failures writing both trace time and completed phases', async() => {
  vi.stubEnv('VITE_PERF_RECONCILE_TRACE', '1');
  const proxy = (await import('@lib/apiManagerProxy')).default as any;
  const error = new Error('storage full');
  const log = vi.spyOn(proxy.log, 'error').mockImplementation(() => {});
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{}');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw error; });
  (globalThis as any).__teagramPerf = {cachedDialogsReconcileMainThreadMsByTraceId: {}};
  try {
    proxy.onMirrorTask({
      name: 'peers', accountNumber: 1, traceOnly: true, trace: 'cachedChannelDialogsReconcile', traceId: 'trace',
      reconcilePhase: {name: 'worker.dialogs.cachedChannelReconcile', traceId: 'trace', durationMs: 10, startedAtEpochMs: 1}
    });
    expect(log).toHaveBeenCalledWith('cached dialog reconcile trace storage write failed', error);
    expect(log).toHaveBeenCalledWith('cached dialog reconcile phase storage write failed', error);
  } finally {
    delete (globalThis as any).__teagramPerf;
  }
});

test('records each walk mirror task interval for attribution', async() => {
  vi.stubEnv('VITE_PERF_RECONCILE_TRACE', '1');
  const proxy = (await import('@lib/apiManagerProxy')).default as any;
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{}');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
  (globalThis as any).__teagramPerf = {cachedDialogsReconcileMainThreadMsByTraceId: {}};
  try {
    proxy.onMirrorTask({name: 'peers', accountNumber: 1, traceOnly: true, trace: 'cachedChannelDialogsReconcile', traceId: 'trace'});
    proxy.onMirrorTask({name: 'peers', accountNumber: 1, traceOnly: true});
    const tasks = (globalThis as any).__teagramPerf.cachedDialogsReconcileMirrorTasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({traceId: 'trace'});
    expect(tasks[0].startedAtMs).toBeGreaterThan(0);
    expect(tasks[0].durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    delete (globalThis as any).__teagramPerf;
  }
});
