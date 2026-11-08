import rootScope from '@lib/rootScope';
import confirmationPopup from '@components/confirmationPopup';
import {toastNew} from '@components/toast';
import {createCurrentGuestAccountLifecycle} from '@lib/guestAccountLifecycle';
import type {GuestAccountManagers} from '@lib/guestAccountLifecycle';

export default function showLogOutPopup() {
  return confirmationPopup({
    titleLangKey: 'LogOut',
    descriptionLangKey: 'Teagram.Guest.SignOutWarning',
    button: {
      langKey: 'LogOut',
      isDanger: true
    }
  }).then(() => {
    const lifecycle = createCurrentGuestAccountLifecycle(rootScope.managers as unknown as GuestAccountManagers);
    return lifecycle.forget().then(async(result): Promise<void> => {
      if(result.kind === 'forgotten' || result.kind === 'cancelled') return;
      if(result.kind !== 'noGuest') {
        toastNew({langPackKey: 'Teagram.Guest.SignOutFailed'});
        return;
      }
      try {
        await rootScope.managers.apiManager.logOut();
      } catch{
        toastNew({langPackKey: 'Teagram.SignOutFailed'});
      }
    }).catch(() => {
      toastNew({langPackKey: 'Teagram.Guest.SignOutFailed'});
    });
  }, (): undefined => undefined);
}
