import {beforeEach, expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  errors: [] as unknown[][]
}));

vi.mock('@lib/appDialogsManager', () => {
  mocks.events.push('dialogs-module');
  return {
    default: {
      start: () => {
        const chatList = document.createElement('div');
        chatList.id = 'chatlist-container';
        document.body.append(chatList);
        mocks.events.push('chatlist-mounted');
      }
    }
  };
});

vi.mock('@lib/appImManager', () => {
  mocks.events.push('im-module');
  return {default: {}};
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

vi.mock('@components/chat/topbar', () => {
  mocks.events.push('topbar-module');
  return {default: class ChatTopbar {}};
});

vi.mock('@components/buttonMenu', () => {
  mocks.events.push('menu-module');
  return {default: async() => document.createElement('div')};
});

vi.mock('@components/appSearchSuper', () => {
  mocks.events.push('search-module');
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
  document.body.innerHTML = '<div id="page-chats"></div>';
  delete (window as any).requestIdleCallback;
});

test('waits for a chat row to paint before scheduling deferred UI imports', async() => {
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
    'first-paint'
  ]);
  expect(idle).toBeUndefined();
  expect(document.body.dataset.deferredUi).toBe('pending');

  const row = document.createElement('div');
  row.className = 'chatlist-chat';
  document.getElementById('chatlist-container')!.append(row);
  await vi.waitFor(() => expect(mocks.events).toContain('idle-scheduled'));
  expect(idleOptions).toEqual({timeout: 2000});
  expect(mocks.events.filter((event) => event === 'first-paint')).toHaveLength(2);

  idle();
  await vi.waitFor(() => expect(document.body.dataset.deferredUi).toBe('ready'));
  expect(mocks.events).toEqual(expect.arrayContaining(['topbar-module', 'menu-module']));
  expect(mocks.events).not.toContain('im-module');
  expect(mocks.events).not.toContain('contacts-module');
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

  expect(mocks.events).not.toContain('topbar-module');
  const row = document.createElement('div');
  row.className = 'chatlist-chat';
  document.getElementById('chatlist-container')!.append(row);
  await vi.waitFor(() => expect(fallback).toBeDefined());
  fallback();
  await vi.waitFor(() => expect(document.body.dataset.deferredUi).toBe('ready'));
});
