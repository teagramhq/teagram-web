import {createSignal, onCleanup, onMount, Show} from 'solid-js';

import Button from '@components/buttonTsx';
import InputField from '@components/inputField';
import LanguageChangeButton from '@components/languageChangeButton';
import MediaHeader from '@components/mediaHeader';
import PasswordInputField from '@components/passwordInputField';
import {wrapFormattedDuration} from '@components/wrappers/wrapDuration';
import {getActiveTurnstileSiteKey, isActiveGuestSignUpEnabled} from '@config/serverContext';
import IS_TOUCH_SUPPORTED from '@environment/touchSupport';
import cancelEvent from '@helpers/dom/cancelEvent';
import formatDuration from '@helpers/formatDuration';
import focusWhenConnected from '@helpers/dom/focusWhenConnected';
import type {HelpTermsOfService, User} from '@layer';
import {createCurrentGuestAccountLifecycle} from '@lib/guestAccountLifecycle';
import type {GuestAccountLifecycleResult, GuestAccountManagers} from '@lib/guestAccountLifecycle';
import {i18n} from '@lib/langPack';
import {getCurrentAccount} from '@lib/accounts/getCurrentAccount';

import AuthCard from '@/pages/AuthCard';
import {CardSpec, useAuthFlow} from '@/pages/authFlow';
import TurnstileChallenge, {useTurnstileChallenge} from '@/pages/TurnstileChallenge';
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
  | 'passwordSetupNetwork'
  | 'guestFlood'
  | 'guestFloodWait'
  | 'guestRestoreFlood'
  | 'guestRestoreFloodWait'
  | 'guestUnrecoverable'
  | 'guestNetwork'
  | 'guestRestoreNetwork'
  | 'guestCollision'
  | 'guestAccountInUse'
  | 'guestSetupPending'
  | 'guestChallenge';

export default function PrivateSignInCard(_props: {spec: Spec}) {
  const {managers, navigate, toIm} = useAuthFlow();
  const turnstile = useTurnstileChallenge();
  const guestSignUpAvailable = isActiveGuestSignUpEnabled();
  let termsDialogReturnFocusTarget: HTMLElement | undefined;
  let acceptedTermsId: string | undefined;

  async function requestTermsAcceptance(terms: HelpTermsOfService): Promise<boolean> {
    const termsId = terms.id?.data;
    if(termsId && acceptedTermsId === termsId) return true;

    try {
      const {SimpleConfirmationPopup} = await import('@components/popups/simpleConfirmation');
      await SimpleConfirmationPopup.show({
        titleLangKey: 'Teagram.Terms.Title',
        descriptionText: terms.text,
        descriptionEntities: terms.entities,
        button: {langKey: 'Teagram.Terms.Accept'},
        cancelLangKey: 'Decline',
        termsDialog: true,
        focusReturnTarget: termsDialogReturnFocusTarget
      });
      if(termsId) acceptedTermsId = termsId;
      return true;
    } catch(error) {
      if(error !== undefined) throw error;
      return false;
    } finally {
      termsDialogReturnFocusTarget = undefined;
    }
  }

  const guestLifecycle = createCurrentGuestAccountLifecycle(managers as unknown as GuestAccountManagers, {
    requestTurnstile: turnstile.request,
    turnstileSiteKey: getActiveTurnstileSiteKey(),
    requestTermsAcceptance
  });
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
  const [guestSubmitting, setGuestSubmitting] = createSignal(false);
  const [restoringGuest, setRestoringGuest] = createSignal(true);
  const [guestFloodWait, setGuestFloodWait] = createSignal<number>();
  const [registrationConfigUnavailable, setRegistrationConfigUnavailable] = createSignal(false);
  const [termsDeclined, setTermsDeclined] = createSignal(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = createSignal<string>();
  const [pendingPasswordUser, setPendingPasswordUser] = createSignal<User>();
  const [error, setError] = createSignal<PrivateUsernameUiError>();

  let cancelled = false;
  let activeIdentifier = '';
  let registrationCreateButton: HTMLElement;
  let guestSignUpButton: HTMLElement;
  let cancelFocus: (() => void) | undefined;
  let guestRestorePromise: Promise<void> = Promise.resolve();
  let guestActionWaiting = false;
  let guestAuthorized = false;

  function updateRegistrationValidity() {
    setHasValidRegistrationInput(
      isPrivateUsername(usernameField.value) &&
      !!displayNameField.value.trim() &&
      !!passwordInput.value &&
      !!confirmPasswordInput.value &&
      (registrationMode() !== 'invite' || !!inviteSecretField.value.trim())
    );
  }

  function updateSignInValidity() {
    setHasValidInput(isPrivateUsername(usernameField.value));
  }

  const onInput = () => {
    updateSignInValidity();
    setError(undefined);
    setGuestFloodWait(undefined);
    setTermsDeclined(false);
    usernameInput.classList.remove('error');
    usernameInput.removeAttribute('aria-invalid');
    updateRegistrationValidity();
  };

  const onRegistrationInput = () => {
    setError(undefined);
    setGuestFloodWait(undefined);
    setTermsDeclined(false);
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
    if(cancelled || submitting() || guestSubmitting() || guestActionWaiting) return;
    setTermsDeclined(false);
    guestActionWaiting = true;
    await guestRestorePromise;
    guestActionWaiting = false;
    if(cancelled || guestAuthorized || submitting() || guestSubmitting()) return;

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

    termsDialogReturnFocusTarget = isCreatingAccount ? registrationCreateButton : undefined;
    activeIdentifier = username;
    if(!isCreatingAccount) usernameField.setValueSilently('');
    setHasValidInput(false);
    setError(undefined);
    setGuestFloodWait(undefined);
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
        requestTermsAcceptance,
        updatePasswordSettings: (password: string) => managers.passwordManager.updateSettings({newPassword: password})
      } : undefined;
      const result = await authenticatePrivateUsername(
        activeIdentifier,
        (method, params, options) => options ?
          managers.apiManager.invokeApi(method as any, params as any, options) :
          managers.apiManager.invokeApi(method as any, params as any),
        () => cancelled,
        registration,
        turnstile.request,
        turnstileSiteKey(),
        (error, shouldRecover) => {
          const recoveryId = error && typeof error === 'object' && 'authKeyRecoveryId' in error ?
            (error as {authKeyRecoveryId?: number}).authKeyRecoveryId :
            undefined;
          return typeof recoveryId === 'number' ?
            managers.apiManager.recoverUnknownAuthKey(recoveryId, shouldRecover) :
            Promise.resolve(false);
        }
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
          updateSignInValidity();
          showError('registrationClosed');
          break;
        case 'termsDeclined':
          setTermsDeclined(true);
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
          if(!isCreatingAccount && (result.authKeyRecoveryFailed || result.errorType === 'AUTH_KEY_UNKNOWN' || result.errorType === 'AUTH_KEY_RATE_LIMIT')) {
            if(!usernameField.value) usernameField.setValueSilently(username);
            updateSignInValidity();
          }
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

  function showGuestErrorType(errorType?: string, restoring = false) {
    const wait = errorType && /FLOOD_WAIT_(\d+)/.exec(errorType);
    if(wait && Number(wait[1]) > 0) {
      setGuestFloodWait(Number(wait[1]));
      showError(restoring ? 'guestRestoreFloodWait' : 'guestFloodWait');
    } else if(errorType && /FLOOD|RATE_LIMIT|SIGNUP_LIMIT|TOO_MANY_SIGN_UPS/i.test(errorType)) {
      showError(restoring ? 'guestRestoreFlood' : 'guestFlood');
    } else if(errorType?.includes('RECAPTCHA_CHECK')) {
      showError('guestChallenge');
    } else {
      showError(restoring ? 'guestRestoreNetwork' : 'guestNetwork');
    }
  }

  function showGuestFailure(result: GuestAccountLifecycleResult, restoring = false) {
    if(cancelled) return;
    switch(result.kind) {
      case 'unrecoverable':
        showError('guestUnrecoverable');
        return;
      case 'collisionsExhausted':
        showError('guestCollision');
        return;
      case 'accountInUse':
        showError('guestAccountInUse');
        return;
      case 'setupPending':
        if(result.errorType) {
          showGuestErrorType(result.errorType, restoring);
        } else {
          showError('guestSetupPending');
        }
        return;
      case 'error':
        showGuestErrorType(result.errorType, restoring);
        return;
    }
  }

  async function handleGuestLifecycleResult(result: GuestAccountLifecycleResult, restoring = false) {
    if(cancelled) return;
    switch(result.kind) {
      case 'authorized':
      case 'resumed':
        guestAuthorized = true;
        await toIm();
        return;
      case 'termsDeclined':
        setTermsDeclined(true);
        return;
      case 'error':
      case 'unrecoverable':
      case 'collisionsExhausted':
      case 'accountInUse':
      case 'setupPending':
        showGuestFailure(result, restoring);
        return;
    }
  }

  async function restoreGuest(): Promise<void> {
    try {
      await handleGuestLifecycleResult(await guestLifecycle.reauthenticate(), true);
    } catch{
      if(!cancelled) showError('guestRestoreNetwork');
    } finally {
      if(!cancelled) setRestoringGuest(false);
    }
  }

  async function tryAsGuest(): Promise<void> {
    if(!guestSignUpAvailable || cancelled || guestSubmitting() || submitting() || guestActionWaiting) return;
    setTermsDeclined(false);
    guestActionWaiting = true;
    await guestRestorePromise;
    guestActionWaiting = false;
    if(cancelled || guestAuthorized || guestSubmitting() || submitting()) return;

    termsDialogReturnFocusTarget = guestSignUpButton;
    setError(undefined);
    setGuestFloodWait(undefined);
    setGuestSubmitting(true);
    try {
      const result = await guestLifecycle.create();
      if(result.kind === 'existing') {
        await handleGuestLifecycleResult(await guestLifecycle.reauthenticate());
      } else {
        await handleGuestLifecycleResult(result);
      }
    } catch{
      if(!cancelled) showError('guestNetwork');
    } finally {
      if(!cancelled) setGuestSubmitting(false);
    }
  }

  function startRegistration() {
    if(registrationMode() === 'closed' || submitting() || guestSubmitting()) return;
    setCreatingAccount(true);
    setError(undefined);
    setGuestFloodWait(undefined);
    setTermsDeclined(false);
    updateRegistrationValidity();
  }

  function returnToSignIn() {
    if(pendingPasswordUser()) return;
    setCreatingAccount(false);
    setError(undefined);
    setGuestFloodWait(undefined);
    setTermsDeclined(false);
    updateSignInValidity();
    usernameInput.classList.remove('error');
    usernameInput.removeAttribute('aria-invalid');
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
      case 'guestFlood':
        return i18n('Teagram.Guest.Flood');
      case 'guestFloodWait':
        return i18n('Teagram.Guest.FloodWait', [wrapFormattedDuration(formatDuration(guestFloodWait() || 1), true)]);
      case 'guestRestoreFlood':
        return i18n('Teagram.Guest.RestoreFlood');
      case 'guestRestoreFloodWait':
        return i18n('Teagram.Guest.RestoreFloodWait', [wrapFormattedDuration(formatDuration(guestFloodWait() || 1), true)]);
      case 'guestUnrecoverable':
        return i18n('Teagram.Guest.Unrecoverable');
      case 'guestNetwork':
        return i18n('Teagram.Guest.Network');
      case 'guestRestoreNetwork':
        return i18n('Teagram.Guest.RestoreNetwork');
      case 'guestCollision':
        return i18n('Teagram.Guest.Collision');
      case 'guestAccountInUse':
        return i18n('Teagram.Guest.AccountInUse');
      case 'guestSetupPending':
        return i18n('Teagram.Guest.SetupPending');
      case 'guestChallenge':
        return i18n('Teagram.Registration.SecurityCheckFailed');
    }
  }

  onMount(() => {
    managers.appStateManager.pushToState('authState', {_: 'authStateSignIn'});
    guestRestorePromise = restoreGuest();
    Promise.resolve(managers.apiManager.getAppConfig(true)).then((config) => {
      if(cancelled) return;
      const mode = config.registration_mode;
      setRegistrationMode(mode === 'open' || mode === 'invite' ? mode : 'closed');
      setTurnstileSiteKey(config.turnstile?.site_key);
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
    turnstile.cancel();
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
              <img class={styles.logo} src="assets/img/logo.svg" alt="" aria-hidden="true"/>
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
      <Show when={turnstile.challenge()} keyed>
        {(challenge) => <TurnstileChallenge {...challenge}/>}
      </Show>
      {error() && <div class={styles.errorLabel} role="alert">{errorContent()}</div>}
      {registrationConfigUnavailable() && !creatingAccount() && (
        <div class={styles.registrationConfigError} role="status">
          {i18n('Teagram.Registration.ConfigNetwork')}
        </div>
      )}
      {termsDeclined() && (
        <div class={styles.registrationConfigError} role="status">
          {i18n('Teagram.Terms.Declined')}
        </div>
      )}
      {restoringGuest() && !creatingAccount() && (
        <div class={styles.guestLoading} role="status" aria-live="polite">
          {i18n('Teagram.Guest.Restoring')}
        </div>
      )}
      {!creatingAccount() && guestSignUpAvailable && (
        <p class={styles.guestDisclosure}>{i18n('Teagram.Guest.Disclosure')}</p>
      )}
      <div class={styles.registrationActions}>
        {!creatingAccount() ? (
          <>
            <Button
              class={guestSignUpAvailable ? 'btn-secondary' : 'btn-primary btn-color-primary'}
              disabled={!hasValidInput() || submitting() || guestSubmitting()}
              onClick={onSubmit}
            >
              {submitting() ? 'Please wait…' : 'Next'}
            </Button>
            {guestSignUpAvailable && (
              <Button
                class="btn-primary btn-color-primary"
                aria-label={(guestSubmitting() ? i18n('Teagram.Guest.Creating') : i18n('Teagram.Guest.Try')).textContent || 'Try it as a guest'}
                disabled={submitting() || guestSubmitting() || restoringGuest()}
              ref={(element) => guestSignUpButton = element}
                onClick={tryAsGuest}
              >
                {guestSubmitting() ? i18n('Teagram.Guest.Creating') : i18n('Teagram.Guest.Try')}
              </Button>
            )}
            {registrationMode() !== 'closed' && (
              <Button class="btn-secondary" disabled={submitting() || guestSubmitting()} onClick={startRegistration}>
                {i18n('Teagram.Registration.CreateAccount')}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button
              class="btn-primary btn-color-primary"
              disabled={!hasValidRegistrationInput() || submitting() || guestSubmitting()}
              ref={(element) => registrationCreateButton = element}
              onClick={onSubmit}
            >
              {submitting() ? 'Please wait…' : i18n('Teagram.Registration.CreateAccount')}
            </Button>
            {!pendingPasswordUser() && (
              <Button class="btn-secondary" disabled={submitting() || guestSubmitting()} onClick={returnToSignIn}>
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
