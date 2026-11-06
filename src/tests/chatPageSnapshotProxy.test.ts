import {beforeEach, expect, it, vi} from 'vitest';

const testState = vi.hoisted(() => ({reset: false, reject: false, loaded: false}));
vi.hoisted(() => {
  vi.stubGlobal('IntersectionObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('Worker', class {addEventListener() {} removeEventListener() {} postMessage() {} terminate() {}});
  vi.stubGlobal('fetch', async() => ({text: async() => ''}));
});
const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server', authKeyId: 'key'};
const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Hello', date: 1, unread: 0, markedUnread: false, muted: false, pinned: false}];

vi.mock('@environment/webpSupport', () => ({default: false}));
vi.mock('@helpers/setWorkerProxy', () => ({makeWorkerURL: () => ''}));
vi.mock('@appManagers/utils/state/loadState', () => ({default: async() => ({
  1: {resetStorages: new Map(testState.reset ? [['dialogs', []]] : []), state: {}, common: {settings: {}}, newVersion: 1, oldVersion: 1}
})}));
vi.mock('@lib/accounts/getCurrentAccount', () => ({getCurrentAccount: () => 1}));
vi.mock('@stores/appState', async(importOriginal) => ({...await importOriginal<typeof import('@stores/appState')>(), setAppStateSilent: () => {}}));
vi.mock('@stores/appSettings', async(importOriginal) => ({...await importOriginal<typeof import('@stores/appSettings')>(), setAppSettingsSilent: () => {}}));
vi.mock('@lib/chatPageSnapshot', async(importOriginal) => ({
  ...await importOriginal<typeof import('@lib/chatPageSnapshot')>(),
  getChatPageKey: async() => { if(testState.reject) throw new Error('key failed'); return key; },
  loadChatPageSnapshot: async(value: unknown) => { testState.loaded = !!value; },
  readChatPageSnapshot: () => testState.loaded ? rows : undefined,
  forgetLoadedChatPageSnapshot: () => { testState.loaded = false; },
  recoverPasscodeSnapshots: async() => {}
}));

import apiManagerProxy from '@lib/apiManagerProxy';
import AccountController from '@lib/accounts/accountController';

beforeEach(() => {
  testState.reset = false;
  testState.reject = false;
  testState.loaded = false;
  vi.spyOn(AccountController, 'withAccountWriteLock').mockImplementation(async(_account, callback) => callback());
});

it.each(['normal', 'reset', 'rejected'] as const)('wires the synchronous snapshot read after state loading: %s', async(mode) => {
  testState.reset = mode === 'reset';
  testState.reject = mode === 'rejected';
  testState.loaded = true;
  const proxy = Object.create(Object.getPrototypeOf(apiManagerProxy));
  Object.assign(proxy, {dispatchUserAuth: () => {}, mirrors: {}, log: {error: () => {}}});
  await proxy.loadAllStates();
  expect(proxy.readChatPageSnapshot()).toEqual(mode === 'normal' ? rows : undefined);
});
