import {Component, onMount} from 'solid-js';
import Button from '@components/buttonTsx';
import InputField from '@components/inputField';
import {InputFieldTsx} from '@components/inputFieldTsx';
import {putPreloader} from '@components/putPreloader';
import {AppTwoStepVerificationSetTab} from '@components/solidJsTabs/tabs';
import cancelEvent from '@helpers/dom/cancelEvent';
import wrapStickerEmoji from '@components/wrappers/stickerEmoji';
import Section from '@components/section';
import {toastNew} from '@components/toast';
import {useSuperTab} from '@components/solidJsTabs/superTabProvider';
import type {AppTwoStepVerificationHintTab} from '@components/solidJsTabs/tabs';

const TwoStepVerificationHint: Component = () => {
  const [tab] = useSuperTab<typeof AppTwoStepVerificationHintTab>();
  const {plainPassword, newPassword} = tab.payload;

  let inputField!: InputField;

  const stickerContainer = document.createElement('div');
  wrapStickerEmoji({
    div: stickerContainer,
    width: 160,
    height: 160,
    emoji: '💡'
  });

  let btnContinue!: HTMLButtonElement;
  let btnSkip!: HTMLButtonElement;
  let isSavingPassword = false;

  const toggleButtons = (freeze: boolean) => {
    if(freeze) {
      btnContinue.setAttribute('disabled', 'true');
      btnSkip.setAttribute('disabled', 'true');
    } else {
      btnContinue.removeAttribute('disabled');
      btnSkip.removeAttribute('disabled');
    }
  };

  const savePassword = (e?: Event, saveHint?: boolean) => {
    if(e) {
      cancelEvent(e);
    }

    if(isSavingPassword) return;

    const hint = saveHint ? inputField.value : undefined;
    if(hint && newPassword === hint) {
      toastNew({langPackKey: 'PasswordAsHintError'});
      return;
    }

    isSavingPassword = true;
    toggleButtons(true);
    const preloader = putPreloader(saveHint ? btnContinue : btnSkip);

    tab.managers.passwordManager.updateSettings({
      hint,
      currentPassword: plainPassword,
      newPassword
    }).then(() => {
      tab.slider.createTab(AppTwoStepVerificationSetTab).open({messageFor: 'password'});
    }, () => {
      isSavingPassword = false;
      toggleButtons(false);
      preloader.remove();
      toastNew({langPackKey: 'Error.AnError'});
    });
  };

  const onContinueClick = (e?: Event) => savePassword(e, true);
  const onSkipClick = (e?: Event) => savePassword(e, false);

  onMount(() => {
    tab.container.classList.add('two-step-verification', 'two-step-verification-hint');

    inputField.input.addEventListener('keypress', (e) => {
      if(e.key === 'Enter') {
        cancelEvent(e);
        return inputField.value ? onContinueClick() : onSkipClick();
      }
    });
  });

  (tab as any)._onOpenAfterTimeout = () => {
    inputField.input.focus();
  };

  return (
    <Section noDelimiter>
      {stickerContainer}
      <div class="input-wrapper">
        <InputFieldTsx
          name="hint"
          label="TwoStepAuth.SetupHintPlaceholder"
          instanceRef={(ref) => inputField = ref}
        />
        <Button ref={btnContinue} primaryFilled text="Continue" onClick={onContinueClick} />
        <Button
          ref={btnSkip}
          class="btn-primary btn-secondary btn-primary-transparent primary"
          text="Teagram.TwoStep.SkipHint"
          onClick={onSkipClick}
        />
      </div>
    </Section>
  );
};

export default TwoStepVerificationHint;
