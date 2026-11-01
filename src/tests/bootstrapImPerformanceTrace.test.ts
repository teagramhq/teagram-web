import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {PerformancePhaseTrace} from '@lib/appManagers/performanceTrace';

const traceMocks = vi.hoisted(() => ({
  startFirstDialogsDispatchTrace: vi.fn(),
  appDialogsManagerStart: vi.fn()
}));

vi.mock('@helpers/dom/loadFonts', () => ({default: () => Promise.resolve()}));
vi.mock('@helpers/schedulers', () => ({doubleRaf: () => Promise.resolve()}));
vi.mock('@helpers/voiceRecorder/isNativeSupported', () => ({default: () => true}));
vi.mock('@lib/rootScope', () => ({
  default: {
    managers: {
      apiManager: {
        startFirstDialogsDispatchTrace: traceMocks.startFirstDialogsDispatchTrace
      },
      appStateManager: {
        pushToState: () => Promise.resolve()
      }
    }
  }
}));
vi.mock('@lib/appDialogsManager', () => ({default: {start: traceMocks.appDialogsManagerStart}}));
vi.mock('@helpers/dom/requestVideoFrameCallbackPolyfill', () => ({}));
vi.mock('@/pages/mountAuthFlow', () => ({disposeActiveAuthFlow: () => {}}));

describe('bootstrapIm performance trace', () => {
  let trace: PerformancePhaseTrace;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_PERF_TRACE', '1');
    traceMocks.startFirstDialogsDispatchTrace.mockReset();
    traceMocks.appDialogsManagerStart.mockReset();
    trace = new PerformancePhaseTrace(true);
    vi.doMock('@lib/appManagers/performanceTrace', () => ({performancePhaseTrace: trace}));
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    document.body.innerHTML = '<div id="page-chats"></div>';
    performance.clearMeasures();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock('@lib/appManagers/performanceTrace');
    document.body.innerHTML = '';
    performance.clearMeasures();
  });

  test('records each awaited bootstrap step as a main-thread span', async() => {
    const {bootstrapIm} = await import('../pages/bootstrapIm');

    await bootstrapIm();

    const phases = trace.getSnapshot();
    const names = phases.map((phase) => phase.name);
    expect(names).toEqual(expect.arrayContaining([
      'main.bootstrapIm.authState',
      'main.bootstrapIm.appDialogsManager.import',
      'main.bootstrapIm.recorder.import',
      'main.bootstrapIm.fonts',
      'main.bootstrapIm.videoFrameCallbackPolyfill.import',
      'main.bootstrapIm.dependencies.wait',
      'main.bootstrapIm.chatlist.mount.wait'
    ]));
    expect(traceMocks.startFirstDialogsDispatchTrace).toHaveBeenCalledOnce();
    expect(traceMocks.startFirstDialogsDispatchTrace).toHaveBeenCalledWith(expect.any(Number));
    expect(traceMocks.startFirstDialogsDispatchTrace.mock.invocationCallOrder[0]).toBeLessThan(
      traceMocks.appDialogsManagerStart.mock.invocationCallOrder[0]
    );
    expect(performance.getEntriesByType('measure').map((entry) => entry.name)).toEqual(expect.arrayContaining(
      names
    ));
  });
});
