import type {AppNewGroupTab} from '@components/solidJsTabs/tabs';
import {AppAddMembersTab, AppNotificationsTab, AppPasscodeEnterPasswordTab, AppPasscodeLockTab, AppPrivacyAndSecurityTab, AppUserPermissionsTab} from '@components/solidJsTabs/tabs';


export type ProvidedTabs = {
  AppPasscodeLockTab: typeof AppPasscodeLockTab;
  AppPasscodeEnterPasswordTab: typeof AppPasscodeEnterPasswordTab;
  AppNotificationsTab: typeof AppNotificationsTab;
  AppAddMembersTab: typeof AppAddMembersTab;
  AppPrivacyAndSecurityTab: typeof AppPrivacyAndSecurityTab;
  AppUserPermissionsTab: typeof AppUserPermissionsTab;

  // Other non solid-js tabs
  AppNewGroupTab: typeof AppNewGroupTab;
};

/**
 * To avoid circular imports, other tabs should be assigned elsewhere in the app (they can be assigned in the module of the tab itself)
 */
export const providedTabs = {
  // * getters keep this module safe to evaluate while `tabs.ts` is still mid-evaluation in an import cycle
  get AppPasscodeLockTab() { return AppPasscodeLockTab; },
  get AppPasscodeEnterPasswordTab() { return AppPasscodeEnterPasswordTab; },
  get AppNotificationsTab() { return AppNotificationsTab; },
  get AppAddMembersTab() { return AppAddMembersTab; },
  get AppPrivacyAndSecurityTab() { return AppPrivacyAndSecurityTab; },
  get AppUserPermissionsTab() { return AppUserPermissionsTab; }

  // Others to be assigned...
} as ProvidedTabs;
