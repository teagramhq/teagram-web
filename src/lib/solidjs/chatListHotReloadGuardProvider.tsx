import type {ParentProps} from 'solid-js';
import {AppChatFoldersTab, AppEditFolderTab} from '@components/solidJsTabs/tabs';
import appSidebarLeft from '@components/sidebarLeft';
import {StoriesSegments} from '@components/avatarNew';
import {PeerTitleTsx} from '@components/peerTitleTsx';
import {i18n} from '@lib/langPack';
import {SolidJSHotReloadGuardContext} from '@lib/solidjs/hotReloadGuard';
import type {SolidJSHotReloadGuardContextValue} from '@lib/solidjs/hotReloadGuard';
import rootScope from '@lib/rootScope';
import wrapFolderTitle from '@components/wrappers/folderTitle';

export default function ChatListHotReloadGuardProvider(props: ParentProps) {
  const contextValue = {
    rootScope,
    appSidebarLeft,
    AppChatFoldersTab,
    AppEditFolderTab,
    i18n,
    wrapFolderTitle,
    PeerTitleTsx,
    StoriesSegments
  } as SolidJSHotReloadGuardContextValue;

  return (
    <SolidJSHotReloadGuardContext.Provider value={contextValue}>
      {props.children}
    </SolidJSHotReloadGuardContext.Provider>
  );
}
