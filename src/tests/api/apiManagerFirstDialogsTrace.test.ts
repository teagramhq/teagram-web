import {afterEach, expect, test, vi} from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

test('finishes the chat-list startup span when the first getDialogs dispatch occurs in ApiManager', async() => {
  vi.stubEnv('VITE_PERF_TRACE', '1');
  vi.resetModules();
  const {PerformanceRpcTrace, performancePhaseTrace} = await import('@appManagers/performanceTrace');
  const {ApiManager} = await import('@appManagers/apiManager');
  const name = 'worker.chatlist.startToFirstGetDialogs';
  const trace = performancePhaseTrace;
  trace.reset();

  const manager = Object.create(ApiManager.prototype) as any;
  manager.performanceRpcTrace = new PerformanceRpcTrace(true);
  const request = Promise.resolve({});
  manager.invokeApiInternal = vi.fn(() => request);
  const startedAtEpochMs = performance.timeOrigin + performance.now() - 50;

  manager.startFirstDialogsDispatchTrace(startedAtEpochMs);
  expect(manager.invokeApi('messages.getDialogs')).toBe(request);
  expect(trace.getSnapshot()).toMatchObject([{name, startedAtEpochMs, durationMs: expect.any(Number)}]);
  expect(trace.getSnapshot()[0].durationMs).toBeGreaterThanOrEqual(50);
});

test('keeps the chat-list startup span open for unrelated requests', async() => {
  vi.stubEnv('VITE_PERF_TRACE', '1');
  vi.resetModules();
  const {PerformanceRpcTrace, performancePhaseTrace} = await import('@appManagers/performanceTrace');
  const {ApiManager} = await import('@appManagers/apiManager');
  const name = 'worker.chatlist.startToFirstGetDialogs';
  const trace = performancePhaseTrace;
  trace.reset();

  const manager = Object.create(ApiManager.prototype) as any;
  manager.performanceRpcTrace = new PerformanceRpcTrace(true);
  manager.invokeApiInternal = vi.fn(() => Promise.resolve({}));
  manager.startFirstDialogsDispatchTrace(performance.timeOrigin + performance.now());
  manager.invokeApi('help.getAppConfig');

  expect(trace.getSnapshot()).toMatchObject([{name, durationMs: null}]);
});

test('does not record RPC activity when performance tracing is disabled', async() => {
  vi.stubEnv('VITE_PERF_TRACE', '0');
  vi.resetModules();
  const {ApiManager} = await import('@appManagers/apiManager');
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as any);
  const manager = new ApiManager();
  const request = Promise.resolve({});
  vi.spyOn(manager as any, 'invokeApiInternal').mockReturnValue(request);

  expect(manager.invokeApi('help.getAppConfig')).toBe(request);
  expect(manager.trackPerformanceRpcWait('users.getUsers', request)).toBe(request);
  expect((manager as any).performanceRpcTrace).toBeUndefined();
  expect(manager.getPerformanceRpcTrace()).toEqual({
    enabled: false,
    recording: false,
    callCount: 0,
    invocations: [],
    calls: []
  });
  expect(manager.getPerformancePhaseTrace()).toEqual([]);
});
