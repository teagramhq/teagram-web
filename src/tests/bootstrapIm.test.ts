import {beforeEach, expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  errors: [] as unknown[][],
  initializeChatUi: vi.fn(() => Promise.resolve())
}));

vi.mock('@lib/appDialogsManager', () => {
  mocks.events.push('dialogs-module');
  return {
    default: {
      start: () => mocks.events.push('chatlist-mounted')
    }
  };
});

vi.mock('@lib/appImManager', () => {
  mocks.events.push('im-module');
  return {
    default: {
      initializeChatUi: mocks.initializeChatUi
    }
  };
});

vi.mock('@lib/rootScope', () => ({
  default: {
    managers: {
      appStateManager: {
        pushToState: async() => mocks.events.push('state-updated')
      }
    }
  }
}));

vi.mock('@helpers/schedulers', () => ({
  doubleRaf: async() => mocks.events.push('first-paint')
}));

vi.mock('@lib/logger', () => ({
  logger: () => ({
    error: (...args: unknown[]) => mocks.errors.push(args)
  }),
  LogTypes: {}
}));

vi.mock('@components/appSearchSuper', () => {
  mocks.events.push('search-module');
  return {default: {}};
});

vi.mock('@components/buttonMenu', () => {
  mocks.events.push('menu-module');
  return {default: {}};
});

vi.mock('@components/sidebarLeft/tabs/contacts', () => {
  mocks.events.push('contacts-module');
  return {default: {}};
});
vi.mock('@helpers/dom/loadFonts', () => ({default: () => Promise.resolve()}));
vi.mock('@helpers/voiceRecorder/isNativeSupported', () => ({default: () => true}));
vi.mock('@/pages/mountAuthFlow', () => ({disposeActiveAuthFlow: vi.fn()}));

async function loadBootstrapIm() {
  vi.resetModules();
  return import('@/pages/bootstrapIm');
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.events.length = 0;
  mocks.errors.length = 0;
  mocks.initializeChatUi.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = '<div id="page-chats"></div>';
  delete (window as any).requestIdleCallback;
});

test('schedules deferred UI imports when idle after the chat list paints', async() => {
  let idle: () => void;
  let idleOptions: {timeout?: number};
  (window as any).requestIdleCallback = (callback: () => void, options: {timeout?: number}) => {
    mocks.events.push('idle-scheduled');
    idle = callback;
    idleOptions = options;
    return 1;
  };

  const {bootstrapIm} = await loadBootstrapIm();
  await bootstrapIm();

  expect(mocks.events).toEqual([
    'state-updated',
    'dialogs-module',
    'chatlist-mounted',
    'first-paint',
    'idle-scheduled'
  ]);
  expect(idleOptions).toEqual({timeout: 2000});
  expect(document.body.dataset.deferredUi).toBe('pending');

  idle();
  await vi.waitFor(() => expect(mocks.initializeChatUi).toHaveBeenCalledTimes(1));
  expect(mocks.events).toEqual(expect.arrayContaining([
    'im-module',
    'search-module',
    'menu-module',
    'contacts-module'
  ]));
  await vi.waitFor(() => expect(document.body.dataset.deferredUi).toBe('ready'));
});

test('logs a rejected chat UI initialization from the deferred loader', async() => {
  let idle: () => void;
  (window as any).requestIdleCallback = (callback: () => void) => {
    idle = callback;
    return 1;
  };
  mocks.initializeChatUi.mockRejectedValueOnce(new Error('chat UI chunk failed'));

  const {bootstrapIm} = await loadBootstrapIm();
  await bootstrapIm();

  idle();
  await vi.waitFor(() => expect(mocks.errors).toHaveLength(1));
  expect(mocks.initializeChatUi).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(document.body.dataset.deferredUi).toBe('ready'));
});

test('loads deferred UI through the timeout fallback when requestIdleCallback is unavailable', async() => {
  let fallback: () => void;
  const originalSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if(delay === 0) {
      fallback = callback as () => void;
      return 1 as any;
    }

    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);

  const {bootstrapIm} = await loadBootstrapIm();
  await bootstrapIm();

  expect(mocks.initializeChatUi).not.toHaveBeenCalled();
  fallback();
  await vi.waitFor(() => expect(mocks.initializeChatUi).toHaveBeenCalledTimes(1));
});
