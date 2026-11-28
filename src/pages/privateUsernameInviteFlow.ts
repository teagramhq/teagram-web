import {toastNew} from '@components/toast';
import {MAX_ACCOUNTS_FREE, MAX_ACCOUNTS_PREMIUM} from '@lib/accounts/constants';
import AccountController from '@lib/accounts/accountController';
import apiManagerProxy from '@lib/apiManagerProxy';
import {getActiveServerHost} from '@config/serverContext';
import {encodeFragmentLink, fromHex} from '@lib/fragmentLink';

import {
  restorePrivateUsernameInviteSecretForRetry,
  restorePrivateUsernameV1InviteSecretForRetry,
  storePrivateUsernameInviteSecretForAccountSwitch
} from '@/pages/privateUsernameInvite';

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
