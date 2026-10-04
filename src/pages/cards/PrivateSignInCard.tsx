import {createSignal, onCleanup, onMount} from 'solid-js';

import Button from '@components/buttonTsx';
import InputField from '@components/inputField';
import LanguageChangeButton from '@components/languageChangeButton';
import MediaHeader from '@components/mediaHeader';
import IS_TOUCH_SUPPORTED from '@environment/touchSupport';
import cancelEvent from '@helpers/dom/cancelEvent';
import focusWhenConnected from '@helpers/dom/focusWhenConnected';
import {getCurrentAccount} from '@lib/accounts/getCurrentAccount';

import AuthCard from '@/pages/AuthCard';
import {CardSpec, useAuthFlow} from '@/pages/authFlow';
import {authenticatePrivateUsername, isPrivateUsername} from '@/pages/privateUsernameAuth';
import {markPrivateUsernameLogin} from '@/pages/privateUsernameLoginState';
import styles from '@/pages/authFlow.module.scss';

if(import.meta.hot) import.meta.hot.accept();

type Spec = Extract<CardSpec, {name: 'signIn'}>;

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

  const [hasValidInput, setHasValidInput] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<'credentials' | 'network' | undefined>();

  let cancelled = false;
  let activeIdentifier = '';
  let cancelFocus: (() => void) | undefined;

  const onInput = () => {
    setHasValidInput(isPrivateUsername(usernameField.value));
    setError(undefined);
    usernameInput.classList.remove('error');
    usernameInput.removeAttribute('aria-invalid');
  };

  usernameInput.addEventListener('input', onInput);
  usernameInput.addEventListener('keydown', (event) => {
    if(event.key === 'Enter') {
      event.preventDefault();
      onSubmit();
    }
  });

  async function onSubmit(event?: Event): Promise<void> {
    if(event) cancelEvent(event);
    if(cancelled || submitting()) return;
    if(!isPrivateUsername(usernameField.value)) return;

    activeIdentifier = usernameField.value;
    usernameField.setValueSilently('');
    setHasValidInput(false);
    setError(undefined);
    setSubmitting(true);

    try {
      const result = await authenticatePrivateUsername(
        activeIdentifier,
        (method, params, options) => options ?
          managers.apiManager.invokeApi(method as any, params as any, options) :
          managers.apiManager.invokeApi(method as any, params as any),
        () => cancelled
      );
      activeIdentifier = '';

      switch(result.kind) {
        case 'invalidInput':
        case 'cancelled':
          return;
        case 'invalidCredentials':
          setError('credentials');
          usernameInput.classList.add('error');
          usernameInput.setAttribute('aria-invalid', 'true');
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
          setError('network');
          break;
      }
    } catch{
      if(!cancelled) setError('network');
    } finally {
      activeIdentifier = '';
      if(!cancelled) setSubmitting(false);
    }
  }

  onMount(() => {
    managers.appStateManager.pushToState('authState', {_: 'authStateSignIn'});
    if(!IS_TOUCH_SUPPORTED) {
      cancelFocus = focusWhenConnected(usernameInput, () => !cancelled);
    }
  });

  onCleanup(() => {
    cancelled = true;
    activeIdentifier = '';
    usernameField.setValueSilently('');
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
          <MediaHeader.Title>Telegram</MediaHeader.Title>
          <MediaHeader.Subtitle class="secondary">Sign in with your username</MediaHeader.Subtitle>
        </MediaHeader>
      }
    >
      {usernameField.container}
      {error() === 'credentials' && <div class={styles.errorLabel} role="alert">invalid username or password</div>}
      {error() === 'network' && <div class={styles.errorLabel} role="alert">Unable to sign in. Try again.</div>}
      <Button
        class="btn-primary btn-color-primary"
        disabled={!hasValidInput() || submitting()}
        onClick={onSubmit}
      >
        {submitting() ? 'Please wait…' : 'Next'}
      </Button>
      {getCurrentAccount() === 1 && <LanguageChangeButton />}
    </AuthCard>
  );
}
