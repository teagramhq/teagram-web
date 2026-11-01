import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {PerformancePhaseTrace} from '@lib/appManagers/performanceTrace';

vi.mock('@helpers/dom/loadFonts', () => ({default: () => Promise.resolve()}));
vi.mock('@helpers/schedulers', () => ({doubleRaf: () => Promise.resolve()}));
vi.mock('@helpers/voiceRecorder/isNativeSupported', () => ({default: () => true}));
vi.mock('@lib/rootScope', () => ({
  default: {
    managers: {
      appStateManager: {
        pushToState: () => Promise.resolve()
      }
    }
  }
}));
vi.mock('@lib/appDialogsManager', () => ({default: {start: () => {}}}));
vi.mock('@helpers/dom/requestVideoFrameCallbackPolyfill', () => ({}));
vi.mock('@/pages/mountAuthFlow', () => ({disposeActiveAuthFlow: () => {}}));

describe('bootstrapIm performance trace', () => {
  let trace: PerformancePhaseTrace;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_PERF_TRACE', '1');
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
    const startUntil = vi.spyOn(trace, 'startUntil');
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
      'main.chatlist.startToFirstGetDialogs',
      'main.bootstrapIm.chatlist.mount.wait'
    ]));
    expect(startUntil).toHaveBeenCalledWith('main.chatlist.startToFirstGetDialogs');
    expect(performance.getEntriesByType('measure').map((entry) => entry.name)).toEqual(expect.arrayContaining(
      names.filter((name) => name !== 'main.chatlist.startToFirstGetDialogs')
    ));
  });
});
