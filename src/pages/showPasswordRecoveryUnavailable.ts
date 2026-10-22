import {SimpleConfirmationPopup} from '@components/popups/simpleConfirmation';
import {toastNew} from '@components/toast';

export default function showPasswordRecoveryUnavailable() {
  return SimpleConfirmationPopup.show({
    titleLangKey: 'Teagram.PasswordRecovery.Title',
    descriptionLangKey: 'Teagram.PasswordRecovery.Unavailable',
    button: {langKey: 'OK', isCancel: true}
  }).catch((error) => {
    if(error !== undefined) {
      toastNew({langPackKey: 'Error.AnError'});
    }
  });
}
