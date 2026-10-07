import {createSignal, onCleanup, onMount, Show} from 'solid-js';

import Button from '@components/buttonTsx';
import {IconTsx} from '@components/iconTsx';
import LanguageChangeButton from '@components/languageChangeButton';
import PasskeyLoginButton from '@components/passkeyLoginButton';
import {putPreloader} from '@components/putPreloader';
import MediaHeader from '@components/mediaHeader';
import bytesCmp from '@helpers/bytes/bytesCmp';
import bytesToBase64 from '@helpers/bytes/bytesToBase64';
import fixBase64String from '@helpers/fixBase64String';
import pause from '@helpers/schedulers/pause';
import {paintQrCode} from '@helpers/qrCode/paintQrCode';
import type {DcId} from '@types';
import {AuthAuthorization, AuthLoginToken} from '@layer';
import App from '@config/app';
import {isPrivateMtprotoTarget} from '@config/mtprotoTarget';
import {LangPackKey, i18n} from '@lib/langPack';
import AccountController from '@lib/accounts/accountController';
import {getCurrentAccount} from '@lib/accounts/getCurrentAccount';
import rootScope from '@lib/rootScope';

import AuthCard from '@/pages/AuthCard';
import {CardSpec, useAuthFlow} from '@/pages/authFlow';
import styles from '@/pages/authFlow.module.scss';

if(import.meta.hot) import.meta.hot.accept();

type Spec = Extract<CardSpec, {name: 'signQR'}>;
type QrState = 'loading' | 'unsupported' | 'retryable';
type QrErrorSource = 'export' | 'other';

const FETCH_INTERVAL = 3;
const QR_SIZE = 240;

function getQrErrorType(error: unknown) {
  if(!error || typeof(error) !== 'object') return undefined;

  try {
    const type = (error as {type?: unknown}).type;
    return typeof(type) === 'string' ? type : undefined;
  } catch{
    return undefined;
  }
}

/**
 * Card variant of `pageSignQR`. Polls `auth.exportLoginToken`, paints the QR
 * code into the `auth-image` slot, and stops when the card is left or auth ends.
 */
export default function SignQRCard(_props: {spec: Spec}) {
  const {managers, navigate, toIm} = useAuthFlow();
  const [qrState, setQrState] = createSignal<QrState>('loading');
  const usernameEscape = isPrivateMtprotoTarget();

  let stickerHost: HTMLDivElement;
  let retryButton: HTMLButtonElement;
  let escapeButton: HTMLButtonElement;
  let preloader: HTMLElement | undefined;
  let invalidated = false;
  let attemptGeneration = 0;
  let activeAttempt: number | undefined;
  let paintGeneration = 0;
  let revealTimers: ReturnType<typeof setTimeout>[] = [];

  let lastDrawnToken: Uint8Array | number[] | undefined;
  let prevToken: Uint8Array | number[] | undefined;
  let QRCodeStylingCtor: any;

  const options: {dcId?: DcId, ignoreErrors: true} = {ignoreErrors: true};

  const helpKeys: LangPackKey[] = ['Login.QR.Help1', 'Login.QR.Help2', 'Login.QR.Help3'];
  const helpList = (
    <ol class={styles.qrDescription}>
      {helpKeys.map((key, idx) => (
        <li class={styles.qrDescriptionItem}>
          <span class={styles.qrDescriptionMarker}>{idx + 1}</span>
          {i18n(key)}
        </li>
      ))}
    </ol>
  );

  function isCurrentAttempt(generation: number) {
    return !invalidated && generation === attemptGeneration;
  }

  function clearRevealTimers() {
    revealTimers.forEach((timer) => clearTimeout(timer));
    revealTimers = [];
  }

  function removeQrNodes() {
    if(!stickerHost) return;

    if(preloader) preloader.remove();
    stickerHost.querySelectorAll('.preloader, canvas').forEach((element) => element.remove());
    preloader = undefined;
  }

  function clearQrContent() {
    ++paintGeneration;
    clearRevealTimers();
    lastDrawnToken = undefined;
    prevToken = undefined;
    removeQrNodes();
  }

  function focusAction(state: QrState) {
    const target = state === 'retryable' ? retryButton : escapeButton;
    if(target?.isConnected) target.focus();
  }

  function updateState(next: QrState) {
    const focusedElement = document.activeElement;
    const focusWasRemoved = focusedElement === retryButton && next !== 'retryable';
    const focusFromBody = focusedElement === document.body;
    setQrState(next);

    if(focusWasRemoved || focusFromBody) {
      queueMicrotask(() => {
        if(!invalidated) focusAction(next);
      });
    }
  }

  function invalidateCard() {
    invalidated = true;
    ++attemptGeneration;
    activeAttempt = undefined;
    clearQrContent();
  }

  function invalidateFromUserAuth() {
    invalidated = true;
    activeAttempt = undefined;
    clearQrContent();
  }

  function showFailure(next: Exclude<QrState, 'loading'>, generation: number) {
    if(!isCurrentAttempt(generation)) return;

    clearQrContent();
    ++attemptGeneration;
    if(activeAttempt === generation) activeAttempt = undefined;
    updateState(next);
    console.warn(next === 'unsupported' ? 'SignQRCard: unsupported' : 'SignQRCard: retryable');
  }

  function handleError(error: unknown, source: QrErrorSource, generation: number) {
    if(!isCurrentAttempt(generation)) return true;

    const type = getQrErrorType(error);
    if(type === 'SESSION_PASSWORD_NEEDED') {
      invalidateCard();
      navigate({name: 'password'});
      return true;
    }

    if(type === 'AUTH_TOKEN_EXPIRED') {
      console.warn('SignQRCard: AUTH_TOKEN_EXPIRED');
      return false;
    }

    showFailure(source === 'export' && type === 'INPUT_METHOD_INVALID' ? 'unsupported' : 'retryable', generation);
    return true;
  }

  async function paintQR(token: Uint8Array | number[], generation: number) {
    if(!QRCodeStylingCtor || !isCurrentAttempt(generation) || qrState() !== 'loading') return;

    const currentPaint = ++paintGeneration;
    clearRevealTimers();
    const paintHost = document.createElement('div');
    const encoded = bytesToBase64(token);
    const url = 'tg://login?token=' + fixBase64String(encoded, true);

    try {
      const style = window.getComputedStyle(document.documentElement);
      const surfaceColor = style.getPropertyValue('--light-filled-primary-color').trim();
      const textColor = style.getPropertyValue('--primary-text-color').trim();
      const primaryColor = style.getPropertyValue('--primary-color').trim();
      const {canvas} = await paintQrCode({
        data: url,
        size: QR_SIZE,
        host: paintHost,
        background: surfaceColor,
        foreground: textColor,
        logoColor: primaryColor,
        canvasClass: styles.qrCanvas,
        QRCodeStylingCtor
      });

      if(currentPaint !== paintGeneration || !isCurrentAttempt(generation) || qrState() !== 'loading') return;
      if(!canvas) throw new Error('QR canvas was not created');

      const hidePreloader = !!preloader;
      stickerHost.querySelectorAll('canvas').forEach((element) => element.remove());
      if(!hidePreloader) stickerHost.querySelectorAll('.preloader').forEach((element) => element.remove());

      if(hidePreloader) {
        preloader!.style.animation = 'hide-icon .4s forwards';
        canvas.style.display = 'none';
        canvas.style.animation = 'grow-icon .4s forwards';
      }

      stickerHost.appendChild(canvas);
      lastDrawnToken = token;

      if(hidePreloader) {
        preloader = undefined;
        revealTimers = [
          setTimeout(() => {
            if(currentPaint === paintGeneration && isCurrentAttempt(generation) && qrState() === 'loading' && stickerHost.contains(canvas)) {
              canvas.style.display = '';
            }
          }, 150),
          setTimeout(() => {
            if(currentPaint === paintGeneration && isCurrentAttempt(generation) && qrState() === 'loading' && stickerHost.contains(canvas)) {
              canvas.style.animation = '';
            }
          }, 500)
        ];
      }
    } catch{
      if(currentPaint === paintGeneration && isCurrentAttempt(generation) && qrState() === 'loading') {
        showFailure('retryable', generation);
      }
    } finally {
      paintHost.replaceChildren();
    }
  }

  const onThemeChanged = () => {
    if(invalidated || qrState() !== 'loading') return;
    const token = prevToken || lastDrawnToken;
    if(token) void paintQR(token, attemptGeneration);
  };

  const onUserAuth = () => {
    invalidateFromUserAuth();
  };

  async function iterate(generation: number): Promise<boolean> {
    try {
      const userIds = await AccountController.getUserIds();
      if(!isCurrentAttempt(generation)) return true;

      let loginToken: AuthLoginToken;
      try {
        loginToken = await managers.apiManager.invokeApi('auth.exportLoginToken', {
          api_id: App.id,
          api_hash: App.hash,
          except_ids: userIds.map((userId) => userId.toUserId())
        }, {ignoreErrors: true}) as AuthLoginToken;
      } catch(error) {
        return handleError(error, 'export', generation);
      }

      if(!isCurrentAttempt(generation)) return true;
      if(!loginToken || typeof(loginToken) !== 'object') throw new Error('Invalid QR token response');

      if(loginToken._ === 'auth.loginTokenMigrateTo') {
        if(!options.dcId) {
          if(!isCurrentAttempt(generation)) return true;
          options.dcId = loginToken.dc_id as DcId;
          await managers.apiManager.setBaseDcId(loginToken.dc_id);
          if(!isCurrentAttempt(generation)) return true;
        }

        try {
          loginToken = await managers.apiManager.invokeApi('auth.importLoginToken', {
            token: loginToken.token
          }, options) as AuthLoginToken.authLoginToken;
        } catch(error) {
          return handleError(error, 'other', generation);
        }

        if(!isCurrentAttempt(generation)) return true;
        if(!loginToken || typeof(loginToken) !== 'object') throw new Error('Invalid QR token response');
      }

      if(loginToken._ === 'auth.loginTokenSuccess') {
        const authorization = loginToken.authorization as any as AuthAuthorization.authAuthorization;
        await managers.apiManager.setUser(authorization.user);
        if(generation !== attemptGeneration) return true;
        try {
          await toIm();
        } catch{
          console.warn('SignQRCard: retryable');
        }
        return true;
      }

      if(loginToken._ !== 'auth.loginToken') throw new Error('Invalid QR token response');

      if(!prevToken || !bytesCmp(prevToken, loginToken.token)) {
        prevToken = loginToken.token;
        await paintQR(loginToken.token, generation);
        if(!isCurrentAttempt(generation)) return true;
      }

      const timestamp = Date.now() / 1000;
      const serverTimeOffset = await managers.timeManager.getServerTimeOffset();
      if(!isCurrentAttempt(generation)) return true;
      const diff = loginToken.expires - timestamp - serverTimeOffset;
      await pause(diff > FETCH_INTERVAL ? 1e3 * FETCH_INTERVAL : 1e3 * diff | 0);
      return !isCurrentAttempt(generation);
    } catch(error) {
      return handleError(error, 'other', generation);
    }
  }

  async function runAttempt(generation: number, updateAuthState: boolean) {
    try {
      if(updateAuthState) {
        preloader = putPreloader(stickerHost, true);
        await managers.appStateManager.pushToState('authState', {_: 'authStateSignQr'});
        if(!isCurrentAttempt(generation)) return;
      } else {
        preloader = putPreloader(stickerHost, true);
      }

      if(!QRCodeStylingCtor) {
        const {default: QRCodeStyling} = await import('qr-code-styling' as any);
        if(!isCurrentAttempt(generation)) return;
        QRCodeStylingCtor = QRCodeStyling;
      }

      while(isCurrentAttempt(generation)) {
        const shouldStop = await iterate(generation);
        if(shouldStop || !isCurrentAttempt(generation)) break;
      }
    } catch{
      if(isCurrentAttempt(generation)) showFailure('retryable', generation);
    } finally {
      if(activeAttempt === generation) activeAttempt = undefined;
    }
  }

  function retry() {
    if(invalidated || activeAttempt !== undefined || qrState() !== 'retryable') return;

    clearQrContent();
    updateState('loading');
    const generation = ++attemptGeneration;
    activeAttempt = generation;
    void runAttempt(generation, false);
  }

  rootScope.addEventListener('user_auth', onUserAuth, {once: true});
  rootScope.addEventListener('theme_changed', onThemeChanged);

  onMount(() => {
    const generation = ++attemptGeneration;
    activeAttempt = generation;
    void runAttempt(generation, true);
  });

  onCleanup(() => {
    invalidateCard();
    rootScope.removeEventListener('user_auth', onUserAuth);
    rootScope.removeEventListener('theme_changed', onThemeChanged);
  });

  const title = () => {
    switch(qrState()) {
      case 'unsupported':
        return i18n('Login.QR.Unsupported.Title');
      case 'retryable':
        return i18n('Login.QR.Error.Title');
      default:
        return i18n('Login.QR.Title');
    }
  };

  const subtitle = () => {
    switch(qrState()) {
      case 'unsupported':
        return i18n('Login.QR.Unsupported.Text');
      case 'retryable':
        return i18n('Login.QR.Error.Text');
      default:
        return i18n('Login.QR.Subtitle');
    }
  };

  const escapeClass = () => qrState() === 'unsupported' ? 'btn-primary btn-color-primary' :
    'btn-primary btn-secondary btn-primary-transparent primary';

  return (
    <AuthCard
      class={styles.pageSignQR}
      inputWrapper={false}
      header={
        <MediaHeader marginBottom={qrState() !== 'loading'}>
          <MediaHeader.Sticker
            ref={(element) => stickerHost = element}
            class={styles.qrContainer}
            size={QR_SIZE}
            element={
              <Show when={qrState() !== 'loading'}>
                <IconTsx
                  class={styles.qrStateIcon}
                  icon={qrState() === 'unsupported' ? 'qr' : 'cloud'}
                  aria-hidden="true"
                />
              </Show>
            }
          />
          <MediaHeader.Title>{title()}</MediaHeader.Title>
          <MediaHeader.Subtitle class="secondary">
            <span aria-live="polite" aria-atomic="true">{subtitle()}</span>
          </MediaHeader.Subtitle>
        </MediaHeader>
      }
    >
      <Show when={qrState() === 'loading'}>{helpList}</Show>
      <Show when={qrState() === 'retryable'}>
        <Button
          ref={(element) => retryButton = element as HTMLButtonElement}
          class="btn-primary btn-color-primary"
          onClick={retry}
          text="Login.QR.Retry"
        />
      </Show>
      <Button
        ref={(element) => escapeButton = element as HTMLButtonElement}
        class={escapeClass()}
        onClick={() => {
          invalidateCard();
          navigate({name: 'signIn'});
        }}
        text={usernameEscape ? 'Login.QR.Username' : 'Login.QR.Cancel'}
      />
      {getCurrentAccount() === 1 && <LanguageChangeButton />}
      <PasskeyLoginButton />
    </AuthCard>
  );
}
