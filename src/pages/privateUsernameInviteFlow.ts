import {toastNew} from '@components/toast';
import {MAX_ACCOUNTS_FREE, MAX_ACCOUNTS_PREMIUM} from '@lib/accounts/constants';
import AccountController from '@lib/accounts/accountController';
import apiManagerProxy from '@lib/apiManagerProxy';
import {getActiveServerHost, getRuntimeServerId} from '@config/serverContext';
import {encodeFragmentLink, fromHex} from '@lib/fragmentLink';

import {
  restorePrivateUsernameInviteSecretForRetry,
  storePrivateUsernameInviteSecretForAccountSwitch
} from '@/pages/privateUsernameInvite';
import {restorePrivateUsernameV1InviteSecretForRetry, takePrivateUsernameV1InviteSecretFromFragment} from '@/pages/privateUsernameInviteV1';

type InviteSource = 'legacy' | 'v1';

export async function handleSignedInInviteLink(inviteSecret: string, source: InviteSource = 'legacy') {
  const [totalAccounts, hasSomeonePremium] = await Promise.all([
    AccountController.getTotalAccounts(),
    apiManagerProxy.hasSomeonePremium()
  ]);

  const restoreInviteForRetry = () => source === 'v1' ?
    restorePrivateUsernameV1InviteSecretForRetry(inviteSecret) :
    restorePrivateUsernameInviteSecretForRetry(inviteSecret);
  const showInviteRetryMessage = () => {
    toastNew({langPackKey: restoreInviteForRetry() ? 'Teagram.Invite.Retry' : 'Teagram.Invite.RetryUnavailable'});
  };

  if(
    totalAccounts >= MAX_ACCOUNTS_PREMIUM ||
    (totalAccounts === MAX_ACCOUNTS_FREE && !hasSomeonePremium)
  ) {
    if(!restoreInviteForRetry()) toastNew({langPackKey: 'Teagram.Invite.RetryUnavailable'});
    const {default: AccountsLimitPopup} = await import('@components/sidebarLeft/accountsLimitPopup');
    new AccountsLimitPopup().show();
    return;
  }

  const {default: confirmationPopup} = await import('@components/confirmationPopup');
  try {
    await confirmationPopup({
      titleLangKey: 'Teagram.Invite.AddTitle',
      descriptionLangKey: 'Teagram.Invite.AddText',
      descriptionLangArgs: [getActiveServerHost()],
      button: {langKey: 'Teagram.Invite.AddAccount'}
    });
  } catch(error) {
    if(!restoreInviteForRetry()) toastNew({langPackKey: 'Teagram.Invite.RetryUnavailable'});
    return;
  }

  let accountSwitchHash: string | undefined;
  if(source === 'v1') {
    accountSwitchHash = encodeFragmentLink({type: 5, secret: fromHex(inviteSecret)});
  } else if(!storePrivateUsernameInviteSecretForAccountSwitch(inviteSecret)) {
    showInviteRetryMessage();
    return;
  }

  const {default: appSidebarLeft} = await import('@components/sidebarLeft');
  const result = await appSidebarLeft.addAccount(undefined, true, accountSwitchHash);
  if(result !== 'added') {
    if(result === 'max') {
      const retryStored = restoreInviteForRetry();
      toastNew({langPackKey: retryStored ? 'Error.AnError' : 'Teagram.Invite.RetryUnavailable'});
    } else {
      showInviteRetryMessage();
    }
  }
}

export async function handleSignedInInviteLinks(legacySecret?: string) {
  const v1Secret = takePrivateUsernameV1InviteSecretFromFragment();
  if(v1Secret) {
    if(getRuntimeServerId() !== 'default') return;
    await handleSignedInInviteLink(v1Secret, 'v1').catch(() => {
      toastNew({langPackKey: restorePrivateUsernameV1InviteSecretForRetry(v1Secret) ? 'Teagram.Invite.Retry' : 'Teagram.Invite.RetryUnavailable'});
    });
  } else if(legacySecret) {
    await handleSignedInInviteLink(legacySecret).catch(() => {
      toastNew({langPackKey: restorePrivateUsernameInviteSecretForRetry(legacySecret) ? 'Teagram.Invite.Retry' : 'Teagram.Invite.RetryUnavailable'});
    });
  }
}
