import {expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[]
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
      initializeChatUi: () => mocks.events.push('chat-ui-initialized')
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

vi.mock('@components/appSearchSuper', () => {
  mocks.events.push('search-module');
  return {default: {}};
});

vi.mock('@components/buttonMenu', () => {
  mocks.events.push('menu-module');
  return {default: {}};
});

vi.mock('@helpers/dom/loadFonts', () => ({default: () => Promise.resolve()}));
vi.mock('@helpers/voiceRecorder/isNativeSupported', () => ({default: () => true}));
vi.mock('@/pages/mountAuthFlow', () => ({disposeActiveAuthFlow: vi.fn()}));

import {bootstrapIm} from '@/pages/bootstrapIm';

test('loads chat, search and menu code only when idle after the chat list has painted', async() => {
  mocks.events.length = 0;
  document.body.innerHTML = '<div id="page-chats"></div>';
  let idle: () => void;
  (window as any).requestIdleCallback = (callback: () => void) => {
    idle = callback;
    return 1;
  };

  await bootstrapIm();

  expect(mocks.events).toEqual([
    'state-updated',
    'dialogs-module',
    'chatlist-mounted',
    'first-paint'
  ]);

  idle();
  await vi.waitFor(() => expect(mocks.events).toContain('chat-ui-initialized'));
  expect(mocks.events).toEqual(expect.arrayContaining(['im-module', 'search-module', 'menu-module']));
  delete (window as any).requestIdleCallback;
});
