import {render} from 'solid-js/web';
import {afterEach, expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  menuLoaded: false,
  forumLoaded: false,
  rootScope: {test: 'rootScope'},
  appSidebarLeft: {test: 'appSidebarLeft'},
  AppChatFoldersTab: (): null => null,
  AppEditFolderTab: (): null => null,
  i18n: () => 'translated',
  wrapFolderTitle: () => document.createDocumentFragment(),
  PeerTitleTsx: (): null => null,
  StoriesSegments: (): null => null,
  contextValue: undefined as any
}));

vi.mock('@components/buttonMenu', () => {
  mocks.menuLoaded = true;
  return {default: vi.fn(), ButtonMenuSync: vi.fn()};
});

vi.mock('@components/autonomousDialogList/monoforumThreads', () => {
  mocks.forumLoaded = true;
  return {AutonomousMonoforumThreadList: vi.fn()};
});

vi.mock('@components/avatarNew', () => ({
  StoriesSegments: mocks.StoriesSegments
}));

vi.mock('@components/solidJsTabs/tabs', () => ({
  AppChatFoldersTab: mocks.AppChatFoldersTab,
  AppEditFolderTab: mocks.AppEditFolderTab
}));

vi.mock('@components/sidebarLeft', () => ({default: mocks.appSidebarLeft}));

vi.mock('@components/peerTitleTsx', () => ({
  PeerTitleTsx: mocks.PeerTitleTsx
}));

vi.mock('@lib/rootScope', () => ({default: mocks.rootScope}));

vi.mock('@lib/langPack', () => ({i18n: mocks.i18n}));
vi.mock('@components/wrappers/folderTitle', () => ({default: mocks.wrapFolderTitle}));

import ChatListHotReloadGuardProvider from '@lib/solidjs/chatListHotReloadGuardProvider';
import {useHotReloadGuard} from '@lib/solidjs/hotReloadGuard';

let dispose: (() => void) | undefined;

function ContextConsumer(): null {
  mocks.contextValue = useHotReloadGuard();
  return null;
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  mocks.contextValue = undefined;
});

test('provides archive dialog dependencies without loading chat menus or forum UI', () => {
  expect(mocks.menuLoaded).toBe(false);
  expect(mocks.forumLoaded).toBe(false);

  dispose = render(() => (
    <ChatListHotReloadGuardProvider>
      <ContextConsumer />
    </ChatListHotReloadGuardProvider>
  ), document.body);

  expect(mocks.contextValue.rootScope).toBe(mocks.rootScope);
  expect(mocks.contextValue.appSidebarLeft).toBe(mocks.appSidebarLeft);
  expect(mocks.contextValue.AppChatFoldersTab).toBe(mocks.AppChatFoldersTab);
  expect(mocks.contextValue.AppEditFolderTab).toBe(mocks.AppEditFolderTab);
  expect(mocks.contextValue.i18n).toBe(mocks.i18n);
  expect(mocks.contextValue.wrapFolderTitle).toBe(mocks.wrapFolderTitle);
  expect(mocks.contextValue.PeerTitleTsx).toBe(mocks.PeerTitleTsx);
  expect(mocks.contextValue.StoriesSegments).toBe(mocks.StoriesSegments);
  expect(mocks.menuLoaded).toBe(false);
  expect(mocks.forumLoaded).toBe(false);
});
