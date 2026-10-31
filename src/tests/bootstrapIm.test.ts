import {afterEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  pushToState: vi.fn(() => Promise.resolve()),
  loadFonts: vi.fn()
}));

vi.mock('@lib/rootScope', () => ({
  default: {managers: {appStateManager: {pushToState: mocks.pushToState}}}
}));

vi.mock('@lib/appDialogsManager', () => ({default: {start: mocks.start}}));
vi.mock('@helpers/dom/loadFonts', () => ({default: (types?: Record<string, unknown>) => mocks.loadFonts(types)}));
vi.mock('@helpers/schedulers', () => ({doubleRaf: () => Promise.resolve()}));
vi.mock('@helpers/voiceRecorder/isNativeSupported', () => ({default: () => true}));
vi.mock('@helpers/dom/blurActiveElement', () => ({default: vi.fn()}));
vi.mock('@/pages/mountAuthFlow', () => ({disposeActiveAuthFlow: vi.fn()}));

describe('signed-in app bootstrap', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('starts the chat list without waiting for fonts', async() => {
    let resolveFonts: () => void;
    mocks.loadFonts.mockImplementation(() => new Promise<void>((resolve) => resolveFonts = resolve));

    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn()
    });

    const {bootstrapIm} = await import('@/pages/bootstrapIm');
    const bootstrap = bootstrapIm();
    let startedBeforeFonts = false;
    try {
      await vi.waitFor(() => expect(mocks.loadFonts).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1), {timeout: 100});
      startedBeforeFonts = true;
    } finally {
      resolveFonts();
      await bootstrap;
    }
    expect(startedBeforeFonts).toBe(true);
  });
});
