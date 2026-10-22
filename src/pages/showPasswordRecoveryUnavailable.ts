import {SimpleConfirmationPopup} from '@components/popups/simpleConfirmation';

export default function showPasswordRecoveryUnavailable() {
  return SimpleConfirmationPopup.show({
    titleLangKey: 'Teagram.PasswordRecovery.Title',
    descriptionLangKey: 'Teagram.PasswordRecovery.Unavailable',
    button: {langKey: 'OK'}
  });
}
