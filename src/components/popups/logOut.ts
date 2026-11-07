import rootScope from '@lib/rootScope';
import confirmationPopup from '@components/confirmationPopup';
import {toastNew} from '@components/toast';
import type {GuestAccountManagers} from '@lib/guestAccountLifecycle';

export default function showLogOutPopup() {
  return confirmationPopup({
    titleLangKey: 'LogOut',
    descriptionLangKey: 'Teagram.Guest.SignOutWarning',
    button: {
      langKey: 'LogOut',
      isDanger: true
    }
  }).then(async() => {
    try {
      const {createCurrentGuestAccountLifecycle} = await import('@lib/guestAccountLifecycle');
      const lifecycle = createCurrentGuestAccountLifecycle(rootScope.managers as unknown as GuestAccountManagers);
      const result = await lifecycle.forget();
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
    } catch{
      toastNew({langPackKey: 'Teagram.Guest.SignOutFailed'});
    }
  }, (): undefined => undefined);
}
