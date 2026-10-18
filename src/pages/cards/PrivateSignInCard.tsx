import {createSignal, onCleanup, onMount} from 'solid-js';

import Button from '@components/buttonTsx';
import InputField from '@components/inputField';
import LanguageChangeButton from '@components/languageChangeButton';
import MediaHeader from '@components/mediaHeader';
import PasswordInputField from '@components/passwordInputField';
import IS_TOUCH_SUPPORTED from '@environment/touchSupport';
import cancelEvent from '@helpers/dom/cancelEvent';
import focusWhenConnected from '@helpers/dom/focusWhenConnected';
import type {User} from '@layer';
import {i18n} from '@lib/langPack';
import {getCurrentAccount} from '@lib/accounts/getCurrentAccount';

import AuthCard from '@/pages/AuthCard';
import {CardSpec, useAuthFlow} from '@/pages/authFlow';
import {
  authenticatePrivateUsername,
  getPrivateUsernameRegistrationError,
  isPrivateUsername
} from '@/pages/privateUsernameAuth';
import type {PrivateUsernameRegistrationMode} from '@/pages/privateUsernameAuth';
import {markPrivateUsernameLogin} from '@/pages/privateUsernameLoginState';
import styles from '@/pages/authFlow.module.scss';

if(import.meta.hot) import.meta.hot.accept();

type Spec = Extract<CardSpec, {name: 'signIn'}>;
type PrivateUsernameUiError =
  | 'credentials'
  | 'network'
  | 'usernameTaken'
  | 'invalidUsername'
  | 'invalidDisplayName'
  | 'invalidInvite'
  | 'registrationClosed'
  | 'passwordMismatch'
  | 'weakPassword'
  | 'passwordSetupNetwork';

export default function PrivateSignInCard(_props: {spec: Spec}) {
  const {managers, navigate, toIm} = useAuthFlow();
  const usernameField = new InputField({
    labelText: 'Username',
    maxLength: 32,
    plainText: true,
    autocomplete: 'off'
  });
  const usernameInput = usernameField.input as HTMLInputElement;
  usernameInput.setAttribute('aria-label', 'Username');
  usernameInput.autocapitalize = 'none';
  usernameInput.autocomplete = 'off';
  usernameInput.spellcheck = false;

  const displayNameField = new InputField({label: 'Teagram.Registration.DisplayName', maxLength: 70, plainText: true, autocomplete: 'name'});
  const displayNameInput = displayNameField.input as HTMLInputElement;
  displayNameInput.setAttribute('aria-label', i18n('Teagram.Registration.DisplayName').textContent || 'Display name');

  const inviteSecretField = new InputField({
    label: 'Teagram.Registration.InviteSecret',
    maxLength: 256,
    plainText: true,
    autocomplete: 'off'
  });
  const inviteSecretInput = inviteSecretField.input as HTMLInputElement;
  inviteSecretInput.setAttribute('aria-label', i18n('Teagram.Registration.InviteSecret').textContent || 'Invite secret');
  inviteSecretInput.autocapitalize = 'none';
  inviteSecretInput.autocomplete = 'off';
  inviteSecretInput.spellcheck = false;

  const passwordField = new PasswordInputField({label: 'Teagram.Registration.Password', plainText: true});
  const passwordInput = passwordField.input as HTMLInputElement;
  passwordInput.setAttribute('aria-label', i18n('Teagram.Registration.Password').textContent || 'Password');
  passwordInput.autocomplete = 'new-password';

  const confirmPasswordField = new PasswordInputField({label: 'Teagram.Registration.ConfirmPassword', plainText: true});
  const confirmPasswordInput = confirmPasswordField.input as HTMLInputElement;
  confirmPasswordInput.setAttribute('aria-label', i18n('Teagram.Registration.ConfirmPassword').textContent || 'Confirm password');
  confirmPasswordInput.autocomplete = 'new-password';

  const [hasValidInput, setHasValidInput] = createSignal(false);
  const [hasValidRegistrationInput, setHasValidRegistrationInput] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [registrationMode, setRegistrationMode] = createSignal<PrivateUsernameRegistrationMode>('closed');
  const [creatingAccount, setCreatingAccount] = createSignal(false);
  const [registrationConfigUnavailable, setRegistrationConfigUnavailable] = createSignal(false);
  const [pendingPasswordUser, setPendingPasswordUser] = createSignal<User>();
  const [error, setError] = createSignal<PrivateUsernameUiError>();

  let cancelled = false;
  let activeIdentifier = '';
  let cancelFocus: (() => void) | undefined;

  function updateRegistrationValidity() {
    setHasValidRegistrationInput(
      isPrivateUsername(usernameField.value) &&
      !!displayNameField.value.trim() &&
      !!passwordInput.value &&
      !!confirmPasswordInput.value &&
      (registrationMode() !== 'invite' || !!inviteSecretField.value.trim())
    );
  }

  const onInput = () => {
    setHasValidInput(isPrivateUsername(usernameField.value));
    setError(undefined);
    usernameInput.classList.remove('error');
    usernameInput.removeAttribute('aria-invalid');
    updateRegistrationValidity();
  };

  const onRegistrationInput = () => {
    setError(undefined);
    updateRegistrationValidity();
  };

  usernameInput.addEventListener('input', onInput);
  [displayNameInput, inviteSecretInput, passwordInput, confirmPasswordInput].forEach((input) => {
    input.addEventListener('input', onRegistrationInput);
    input.addEventListener('keydown', (event) => {
      if(event.key === 'Enter') {
        event.preventDefault();
        onSubmit();
      }
    });
  });
  usernameInput.addEventListener('keydown', (event) => {
    if(event.key === 'Enter') {
      event.preventDefault();
      onSubmit();
    }
  });

  function lockAccountFields() {
    usernameInput.disabled = true;
    displayNameInput.disabled = true;
    inviteSecretInput.disabled = true;
  }

  function showError(errorKind: PrivateUsernameUiError) {
    setError(errorKind);
    if(errorKind === 'credentials' || errorKind === 'usernameTaken' || errorKind === 'invalidUsername') {
      usernameInput.classList.add('error');
      usernameInput.setAttribute('aria-invalid', 'true');
    }
  }

  async function finishPendingPasswordSetup(): Promise<void> {
    if(!pendingPasswordUser()) return;
    if(passwordInput.value !== confirmPasswordInput.value) {
      showError('passwordMismatch');
      return;
    }

    const user = pendingPasswordUser();
    try {
      const saved = await managers.passwordManager.updateSettings({newPassword: passwordInput.value});
      if(saved === false) {
        showError('passwordSetupNetwork');
        return;
      }
      if(cancelled) return;
      await managers.apiManager.setUser(user);
      await toIm();
      setPendingPasswordUser(undefined);
    } catch(error) {
      if(cancelled) return;
      if(getPrivateUsernameRegistrationError(error) === 'weakPassword') {
        showError('weakPassword');
        return;
      }

      try {
        const passwordState = await managers.passwordManager.getState();
        if(passwordState.current_algo) {
          await managers.apiManager.setUser(user);
          await toIm();
          setPendingPasswordUser(undefined);
          return;
        }
      } catch{
        showError('passwordSetupNetwork');
        return;
      }

      showError('passwordSetupNetwork');
    }
  }

  async function onSubmit(event?: Event): Promise<void> {
    if(event) cancelEvent(event);
    if(cancelled || submitting()) return;

    const isCreatingAccount = creatingAccount();
    const username = usernameField.value;
    if(!isPrivateUsername(username)) return;

    if(isCreatingAccount) {
      if(!displayNameField.value.trim()) {
        showError('invalidDisplayName');
        return;
      }
      if(!passwordInput.value) return;
      if(passwordInput.value !== confirmPasswordInput.value) {
        showError('passwordMismatch');
        return;
      }
      if(registrationMode() === 'invite' && !inviteSecretField.value.trim()) return;
    }

    activeIdentifier = username;
    if(!isCreatingAccount) usernameField.setValueSilently('');
    setHasValidInput(false);
    setError(undefined);
    setSubmitting(true);

    try {
      if(isCreatingAccount && pendingPasswordUser()) {
        await finishPendingPasswordSetup();
        return;
      }

      const registration = isCreatingAccount ? {
        mode: registrationMode(),
        displayName: displayNameField.value,
        password: passwordInput.value,
        inviteSecret: inviteSecretField.value,
        updatePasswordSettings: (password: string) => managers.passwordManager.updateSettings({newPassword: password})
      } : undefined;
      const result = await authenticatePrivateUsername(
        activeIdentifier,
        (method, params, options) => options ?
          managers.apiManager.invokeApi(method as any, params as any, options) :
          managers.apiManager.invokeApi(method as any, params as any),
        () => cancelled,
        registration
      );
      activeIdentifier = '';

      switch(result.kind) {
        case 'invalidInput':
          showError(isCreatingAccount ? 'invalidUsername' : 'credentials');
          break;
        case 'cancelled':
          return;
        case 'invalidCredentials':
          showError('credentials');
          break;
        case 'usernameTaken':
          showError('usernameTaken');
          break;
        case 'invalidUsername':
          showError('invalidUsername');
          break;
        case 'invalidDisplayName':
          showError('invalidDisplayName');
          break;
        case 'invalidInvite':
          showError('invalidInvite');
          break;
        case 'registrationClosed':
          setRegistrationMode('closed');
          setCreatingAccount(false);
          showError('registrationClosed');
          break;
        case 'weakPassword':
          setPendingPasswordUser(result.user);
          lockAccountFields();
          showError('weakPassword');
          break;
        case 'passwordSetupError':
          setPendingPasswordUser(result.user);
          lockAccountFields();
          showError('passwordSetupNetwork');
          break;
        case 'password':
          markPrivateUsernameLogin();
          navigate({name: 'password'});
          break;
        case 'authorized':
          await managers.apiManager.setUser(result.user);
          await toIm();
          break;
        case 'error':
          showError('network');
          break;
      }
    } catch{
      if(!cancelled) showError('network');
    } finally {
      activeIdentifier = '';
      if(!cancelled) setSubmitting(false);
    }
  }

  function startRegistration() {
    if(registrationMode() === 'closed') return;
    setCreatingAccount(true);
    setError(undefined);
    updateRegistrationValidity();
  }

  function returnToSignIn() {
    if(pendingPasswordUser()) return;
    setCreatingAccount(false);
    setError(undefined);
    usernameInput.disabled = false;
    displayNameInput.disabled = false;
    inviteSecretInput.disabled = false;
    displayNameField.setValueSilently('');
    inviteSecretField.setValueSilently('');
    passwordField.setValueSilently('');
    confirmPasswordField.setValueSilently('');
    setHasValidRegistrationInput(false);
  }

  function errorContent() {
    switch(error()) {
      case 'credentials':
        return 'invalid username or password';
      case 'network':
        return creatingAccount() ? i18n('Teagram.Registration.Network') : 'Unable to sign in. Try again.';
      case 'usernameTaken':
        return i18n('Teagram.Registration.UsernameTaken');
      case 'invalidUsername':
        return i18n('Teagram.Registration.InvalidUsername');
      case 'invalidDisplayName':
        return i18n('Teagram.Registration.InvalidDisplayName');
      case 'invalidInvite':
        return i18n('Teagram.Registration.InvalidInvite');
      case 'registrationClosed':
        return i18n('Teagram.Registration.Closed');
      case 'passwordMismatch':
        return i18n('Teagram.Registration.PasswordMismatch');
      case 'weakPassword':
        return i18n('Teagram.Registration.WeakPassword');
      case 'passwordSetupNetwork':
        return i18n('Teagram.Registration.PasswordNetwork');
    }
  }

  onMount(() => {
    managers.appStateManager.pushToState('authState', {_: 'authStateSignIn'});
    Promise.resolve(managers.apiManager.getAppConfig(true)).then((config) => {
      if(cancelled) return;
      const mode = config.registration_mode;
      setRegistrationMode(mode === 'open' || mode === 'invite' ? mode : 'closed');
      updateRegistrationValidity();
    }).catch(() => {
      if(!cancelled) {
        setRegistrationMode('closed');
        setRegistrationConfigUnavailable(true);
      }
    });
    if(!IS_TOUCH_SUPPORTED) {
      cancelFocus = focusWhenConnected(usernameInput, () => !cancelled);
    }
  });

  onCleanup(() => {
    cancelled = true;
    activeIdentifier = '';
    setPendingPasswordUser(undefined);
    usernameField.setValueSilently('');
    displayNameField.setValueSilently('');
    inviteSecretField.setValueSilently('');
    passwordField.setValueSilently('');
    confirmPasswordField.setValueSilently('');
    cancelFocus?.();
  });

  return (
    <AuthCard
      class={styles.pageSignIn}
      header={
        <MediaHeader>
          <MediaHeader.Sticker
            class={styles.logoContainer}
            size={120}
            element={
              <svg class={styles.logo} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
                <use href="#logo"/>
              </svg>
            }
          />
          <MediaHeader.Title>Teagram</MediaHeader.Title>
          <MediaHeader.Subtitle class="secondary">
            {creatingAccount() ? i18n('Teagram.Registration.Subtitle') : 'Sign in with your username'}
          </MediaHeader.Subtitle>
        </MediaHeader>
      }
    >
      {usernameField.container}
      {creatingAccount() && (
        <div class={styles.registrationFields}>
          {displayNameField.container}
          {registrationMode() === 'invite' && inviteSecretField.container}
          {passwordField.container}
          {confirmPasswordField.container}
        </div>
      )}
      {error() && <div class={styles.errorLabel} role="alert">{errorContent()}</div>}
      {registrationConfigUnavailable() && !creatingAccount() && (
        <div class={styles.registrationConfigError} role="status">
          {i18n('Teagram.Registration.ConfigNetwork')}
        </div>
      )}
      <div class={styles.registrationActions}>
        {!creatingAccount() ? (
          <>
            <Button
              class="btn-primary btn-color-primary"
              disabled={!hasValidInput() || submitting()}
              onClick={onSubmit}
            >
              {submitting() ? 'Please wait…' : 'Next'}
            </Button>
            {registrationMode() !== 'closed' && (
              <Button class="btn-secondary" disabled={submitting()} onClick={startRegistration}>
                {i18n('Teagram.Registration.CreateAccount')}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button
              class="btn-primary btn-color-primary"
              disabled={!hasValidRegistrationInput() || submitting()}
              onClick={onSubmit}
            >
              {submitting() ? 'Please wait…' : i18n('Teagram.Registration.CreateAccount')}
            </Button>
            {!pendingPasswordUser() && (
              <Button class="btn-secondary" disabled={submitting()} onClick={returnToSignIn}>
                {i18n('Teagram.Registration.SignIn')}
              </Button>
            )}
          </>
        )}
      </div>
      {!creatingAccount() && getCurrentAccount() === 1 && <LanguageChangeButton />}
    </AuthCard>
  );
}
