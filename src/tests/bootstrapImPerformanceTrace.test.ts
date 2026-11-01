import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {PerformancePhaseTrace} from '@lib/appManagers/performanceTrace';

const traceMocks = vi.hoisted(() => ({
  startFirstDialogsDispatchTrace: vi.fn(() => Promise.resolve()),
  appDialogsManagerStart: vi.fn(),
  appStatePush: vi.fn(() => Promise.resolve()),
  loggerError: vi.fn()
}));

vi.mock('@helpers/dom/loadFonts', () => ({default: () => Promise.resolve()}));
vi.mock('@helpers/schedulers', () => ({doubleRaf: () => Promise.resolve()}));
vi.mock('@helpers/voiceRecorder/isNativeSupported', () => ({default: () => true}));
vi.mock('@lib/logger', () => ({logger: () => ({error: traceMocks.loggerError})}));
vi.mock('@lib/rootScope', () => ({
  default: {
    managers: {
      apiManager: {
        startFirstDialogsDispatchTrace: traceMocks.startFirstDialogsDispatchTrace
      },
      appStateManager: {
        pushToState: traceMocks.appStatePush
      }
    }
  }
}));
vi.mock('@helpers/dom/requestVideoFrameCallbackPolyfill', () => ({}));
vi.mock('@/pages/mountAuthFlow', () => ({disposeActiveAuthFlow: () => {}}));

describe('bootstrapIm performance trace', () => {
  let trace: PerformancePhaseTrace;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_PERF_TRACE', '1');
    vi.doMock('@lib/appDialogsManager', () => ({default: {start: traceMocks.appDialogsManagerStart}}));
    traceMocks.startFirstDialogsDispatchTrace.mockReset();
    traceMocks.startFirstDialogsDispatchTrace.mockResolvedValue(undefined);
    traceMocks.appDialogsManagerStart.mockReset();
    traceMocks.appStatePush.mockReset();
    traceMocks.appStatePush.mockResolvedValue(undefined);
    traceMocks.loggerError.mockReset();
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
    vi.doUnmock('@lib/appDialogsManager');
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

  test('runs bootstrap without tracing and preserves state-before-chatlist order', async() => {
    vi.stubEnv('VITE_PERF_TRACE', '0');
    vi.resetModules();
    const {bootstrapIm} = await import('../pages/bootstrapIm');

    await bootstrapIm();

    expect(traceMocks.appStatePush).toHaveBeenCalledOnce();
    expect(traceMocks.appStatePush.mock.invocationCallOrder[0]).toBeLessThan(
      traceMocks.appDialogsManagerStart.mock.invocationCallOrder[0]
    );
    expect(traceMocks.startFirstDialogsDispatchTrace).not.toHaveBeenCalled();
    expect(performance.getEntriesByType('measure')).toEqual([]);
  });

  test('propagates an app-dialog manager import rejection without tracing', async() => {
    vi.stubEnv('VITE_PERF_TRACE', '0');
    const error = new Error('app dialogs manager import failed');
    vi.doUnmock('@lib/appDialogsManager');
    vi.doMock('@lib/appDialogsManager', () => {
      throw error;
    });
    vi.resetModules();
    const {bootstrapIm} = await import('../pages/bootstrapIm');

    await expect(bootstrapIm()).rejects.toMatchObject({cause: error});

    expect(traceMocks.startFirstDialogsDispatchTrace).not.toHaveBeenCalled();
    expect(traceMocks.appDialogsManagerStart).not.toHaveBeenCalled();
  });

  test('logs a rejected first-dialogs trace setup without waiting for it', async() => {
    const error = new Error('first dialogs trace setup failed');
    traceMocks.startFirstDialogsDispatchTrace.mockRejectedValueOnce(error);
    const {bootstrapIm} = await import('../pages/bootstrapIm');

    await bootstrapIm();
    await Promise.resolve();

    expect(traceMocks.appDialogsManagerStart).toHaveBeenCalledOnce();
    expect(traceMocks.loggerError).toHaveBeenCalledWith(
      'Failed to start first dialogs dispatch trace',
      error
    );
  });
});
