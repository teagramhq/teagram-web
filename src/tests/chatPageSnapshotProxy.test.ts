import {beforeEach, expect, it, vi} from 'vitest';

const testState = vi.hoisted(() => ({reset: false, reject: false, loaded: false, holdStateLoad: false, releaseStateLoad: undefined as (() => void) | undefined}));
vi.hoisted(() => {
  vi.stubGlobal('IntersectionObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('Worker', class {addEventListener() {} removeEventListener() {} postMessage() {} terminate() {}});
  vi.stubGlobal('fetch', async() => ({text: async() => ''}));
});
const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server', authKeyId: 'key'};
const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Hello', date: 1, unread: 0, markedUnread: false, muted: false, pinned: false}];

vi.mock('@environment/webpSupport', () => ({default: false}));
vi.mock('@helpers/setWorkerProxy', () => ({makeWorkerURL: () => ''}));
vi.mock('@helpers/toggleStorages', () => ({default: async() => {}}));
vi.mock('@lib/telegramMeWebManager', () => ({default: {setAuthorized: async() => {}}}));
vi.mock('@lib/webPushApiManager', () => ({default: {unsubscribe: async() => {}}}));
vi.mock('@appManagers/utils/state/loadState', () => ({default: async() => {
  if(testState.holdStateLoad) {
    await new Promise<void>((resolve) => { testState.releaseStateLoad = resolve; });
  }
  const result = {resetStorages: new Map(testState.reset ? [['dialogs', []]] : []), state: {}, common: {settings: {}}, newVersion: 1, oldVersion: 1, snapshotOwner: key};
  return {1: result};
}}));
vi.mock('@lib/accounts/getCurrentAccount', () => ({getCurrentAccount: () => 1}));
vi.mock('@stores/appState', async(importOriginal) => ({...await importOriginal<typeof import('@stores/appState')>(), setAppStateSilent: () => {}}));
vi.mock('@stores/appSettings', async(importOriginal) => ({...await importOriginal<typeof import('@stores/appSettings')>(), setAppSettingsSilent: () => {}}));
vi.mock('@lib/chatPageSnapshot', async(importOriginal) => ({
  ...await importOriginal<typeof import('@lib/chatPageSnapshot')>(),
  getChatPageKey: async() => { if(testState.reject) throw new Error('key failed'); return key; },
  loadChatPageSnapshot: async(value: unknown) => {
    if(testState.reject) throw new Error('snapshot failed');
    testState.loaded = !!value;
  },
  readChatPageSnapshot: () => testState.loaded ? rows : undefined,
  forgetLoadedChatPageSnapshot: () => {
    testState.loaded = false;
    window.dispatchEvent(new Event('chat-page-snapshot-invalidated'));
  },
  recoverPasscodeSnapshots: async() => {}
}));

import apiManagerProxy from '@lib/apiManagerProxy';
import AccountController from '@lib/accounts/accountController';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';

beforeEach(() => {
  testState.reset = false;
  testState.reject = false;
  testState.loaded = false;
  testState.holdStateLoad = false;
  testState.releaseStateLoad = undefined;
  DeferredIsUsingPasscode.resolveDeferred(false);
  vi.spyOn(AccountController, 'withAccountWriteLock').mockImplementation(async(_account, callback) => callback());
});

it.each(['normal', 'reset', 'rejected'] as const)('preloads the snapshot alongside account state: %s', async(mode) => {
  testState.reset = mode === 'reset';
  testState.reject = mode === 'rejected';
  testState.loaded = true;
  const proxy = Object.create(Object.getPrototypeOf(apiManagerProxy));
  Object.assign(proxy, {dispatchUserAuth: () => {}, mirrors: {}, log: {error: () => {}}});
  await proxy.loadAllStates();
  expect(proxy.readChatPageSnapshot()).toEqual(mode === 'normal' ? rows : undefined);
});

it('loads the snapshot while account state is still loading', async() => {
  testState.holdStateLoad = true;
  const proxy = Object.create(Object.getPrototypeOf(apiManagerProxy));
  Object.assign(proxy, {dispatchUserAuth: () => {}, mirrors: {}, log: {error: () => {}}});

  const loading = proxy.loadAllStates();
  await vi.waitFor(() => expect(testState.loaded).toBe(true));
  expect(testState.releaseStateLoad).toBeTypeOf('function');
  testState.releaseStateLoad!();
  await loading;

  expect(proxy.readChatPageSnapshot()).toEqual(rows);
});

it('removes painted snapshot rows when the API proxy handles logout', async() => {
  const {paintChatPageSnapshot, watchChatPageSnapshot} = await import('@lib/chatPageSnapshotView');
  const {default: rootScope} = await import('@lib/rootScope');
  vi.spyOn(apiManagerProxy as any, 'invokeVoid').mockResolvedValue(undefined);
  vi.spyOn(apiManagerProxy as any, 'onLoggedOut').mockResolvedValue(undefined);
  document.body.innerHTML = '<div id="page-chats"><div id="chatlist-container"></div></div>';
  watchChatPageSnapshot(1, false);
  paintChatPageSnapshot(rows);
  expect(document.querySelector('.chat-page-snapshot')).not.toBeNull();

  rootScope.dispatchEventSingle('logging_out', {accountNumber: 1});

  expect(document.querySelector('.chat-page-snapshot')).toBeNull();
});
