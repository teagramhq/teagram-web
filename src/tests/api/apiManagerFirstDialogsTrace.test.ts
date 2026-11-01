import {afterEach, expect, test, vi} from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test('finishes the chat-list startup span when the first getDialogs request is dispatched', async() => {
  vi.stubEnv('VITE_PERF_TRACE', '1');
  vi.resetModules();
  const {PerformanceRpcTrace, performancePhaseTrace} = await import('@appManagers/performanceTrace');
  const {ApiManager} = await import('@appManagers/apiManager');
  const name = 'main.chatlist.startToFirstGetDialogs';
  const trace = performancePhaseTrace;
  trace.reset();
  trace.startUntil(name);

  const manager = Object.create(ApiManager.prototype) as any;
  manager.performanceRpcTrace = new PerformanceRpcTrace(true);
  const request = Promise.resolve({});

  expect(manager.trackPerformanceRpcWait('messages.getDialogs', request)).toBe(request);
  expect(trace.getSnapshot()).toMatchObject([{name, durationMs: expect.any(Number)}]);
});

test('keeps the chat-list startup span open for unrelated requests', async() => {
  vi.stubEnv('VITE_PERF_TRACE', '1');
  vi.resetModules();
  const {PerformanceRpcTrace, performancePhaseTrace} = await import('@appManagers/performanceTrace');
  const {ApiManager} = await import('@appManagers/apiManager');
  const name = 'main.chatlist.startToFirstGetDialogs.test';
  const trace = performancePhaseTrace;
  trace.reset();
  trace.startUntil(name);

  const manager = Object.create(ApiManager.prototype) as any;
  manager.performanceRpcTrace = new PerformanceRpcTrace(true);
  manager.trackPerformanceRpcWait('help.getAppConfig', Promise.resolve({}));

  expect(trace.getSnapshot()).toMatchObject([{name, durationMs: null}]);
});
