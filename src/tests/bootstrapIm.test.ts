import {afterEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  appDialogsManagerImported: false,
  pushToState: vi.fn(() => Promise.resolve()),
  loadFonts: vi.fn()
}));

vi.mock('@lib/rootScope', () => ({
  default: {managers: {appStateManager: {pushToState: mocks.pushToState}}}
}));

vi.mock('@lib/appDialogsManager', () => {
  mocks.appDialogsManagerImported = true;
  return {default: {start: mocks.start}};
});
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

  it('starts the chat list without waiting for state persistence or fonts', async() => {
    let resolveState: () => void;
    let resolveFonts: () => void;
    mocks.pushToState.mockImplementation(() => new Promise<void>((resolve) => resolveState = resolve));
    mocks.loadFonts.mockImplementation(() => new Promise<void>((resolve) => resolveFonts = resolve));

    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn()
    });

    const {bootstrapIm} = await import('@/pages/bootstrapIm');
    const bootstrap = bootstrapIm();
    let startedBeforeFonts = false;
    let startedBeforeStatePersistence = false;
    let importsStartedBeforeState = false;
    try {
      await vi.waitFor(() => expect(mocks.appDialogsManagerImported).toBe(true), {timeout: 100});
      await vi.waitFor(() => expect(mocks.loadFonts).toHaveBeenCalledTimes(1));
      importsStartedBeforeState = true;
      expect(mocks.pushToState).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1), {timeout: 100});
      startedBeforeStatePersistence = true;
      startedBeforeFonts = true;
    } finally {
      resolveState?.();
      await vi.waitFor(() => expect(mocks.loadFonts).toHaveBeenCalledTimes(1));
      resolveFonts();
      await bootstrap;
    }
    expect(importsStartedBeforeState).toBe(true);
    expect(startedBeforeStatePersistence).toBe(true);
    expect(startedBeforeFonts).toBe(true);
  });

  it('waits for a preloaded chat-list manager before starting it', async() => {
    let resolveManager: (module: {default: {start: typeof mocks.start}}) => void;
    const managerImport = new Promise<unknown>((resolve) => {
      resolveManager = resolve;
    });
    const {bootstrapIm} = await import('@/pages/bootstrapIm');
    const bootstrap = bootstrapIm(managerImport as unknown as Promise<typeof import('@lib/appDialogsManager')>);

    await vi.waitFor(() => expect(mocks.pushToState).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.start).not.toHaveBeenCalled();

    resolveManager({default: {start: mocks.start}});
    await bootstrap;
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
