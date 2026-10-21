import {createSignal, onCleanup, onMount} from 'solid-js';

import Button from '@components/buttonTsx';
import {i18n} from '@lib/langPack';

import styles from '@/pages/authFlow.module.scss';
import {getTurnstileSiteKey} from '@/pages/turnstileSignup';
import type {RequestTurnstileChallenge, TurnstileAction} from '@/pages/turnstileSignup';

type TurnstileAttemptResult = 'retry' | 'complete';
type TurnstileCallbacks = {
  sitekey: string,
  action: TurnstileAction,
  callback: (token: string) => void,
  'expired-callback': () => void,
  'error-callback': () => void
};
type TurnstileApi = {
  render: (container: HTMLElement, callbacks: TurnstileCallbacks) => string,
  reset: (widgetId: string) => void,
  remove: (widgetId: string) => void
};
type TurnstileWindow = Window & {turnstile?: TurnstileApi};
type ChallengeFailure =
  | 'Teagram.Registration.SecurityCheckFailed'
  | 'Teagram.Registration.SecurityCheckExpired'
  | 'Teagram.Registration.SecurityCheckUnavailable';
type ChallengeStatus = 'loading' | 'ready' | 'checking' | 'retry';

let turnstileScriptPromise: Promise<TurnstileApi> | undefined;

export type TurnstileChallengeState = {
  siteKey: string,
  action: TurnstileAction,
  onToken: (token: string) => Promise<TurnstileAttemptResult>
};

export function useTurnstileChallenge() {
  const [challenge, setChallenge] = createSignal<TurnstileChallengeState>();
  let cancelPending: (() => void) | undefined;

  const request: RequestTurnstileChallenge = (initialSiteKey, action, submit) => new Promise((resolve, reject) => {
    let settled = false;
    let siteKey = initialSiteKey;

    const finish = (callback: () => void) => {
      if(settled) return;
      settled = true;
      setChallenge(undefined);
      cancelPending = undefined;
      callback();
    };

    const onToken = async(token: string): Promise<TurnstileAttemptResult> => {
      try {
        const response = await submit(token);
        finish(() => resolve(response));
      } catch(error) {
        const nextSiteKey = getTurnstileSiteKey(error, action);
        if(nextSiteKey) {
          if(nextSiteKey !== siteKey) {
            siteKey = nextSiteKey;
            setChallenge({siteKey, action, onToken});
          }
          return 'retry';
        }

        finish(() => reject(error));
      }

      return 'complete';
    };

    cancelPending = () => finish(() => reject(new Error('Turnstile challenge cancelled')));
    setChallenge({siteKey, action, onToken});
  });

  function cancel() {
    cancelPending?.();
  }

  return {challenge, request, cancel};
}

export default function TurnstileChallenge(props: TurnstileChallengeState) {
  let container!: HTMLDivElement;
  let api: TurnstileApi | undefined;
  let widgetId: string | undefined;
  let disposed = false;
  const [status, setStatus] = createSignal<ChallengeStatus>('loading');
  const [failure, setFailure] = createSignal<ChallengeFailure>();

  function showFailure(message: ChallengeFailure, force = false) {
    if(disposed || (!force && status() === 'checking')) return;
    setFailure(message);
    setStatus('retry');
  }

  async function loadWidget() {
    setStatus('loading');
    setFailure(undefined);

    try {
      api = await loadTurnstile();
      if(disposed) return;

      widgetId = api.render(container, {
        sitekey: props.siteKey,
        action: props.action,
        callback: async(token) => {
          if(disposed || status() !== 'ready') return;
          setStatus('checking');
          try {
            const result = await props.onToken(token);
            if(!disposed && result === 'retry') showFailure('Teagram.Registration.SecurityCheckFailed', true);
          } catch{
            showFailure('Teagram.Registration.SecurityCheckFailed', true);
          }
        },
        'expired-callback': () => showFailure('Teagram.Registration.SecurityCheckExpired'),
        'error-callback': () => showFailure('Teagram.Registration.SecurityCheckFailed')
      });
      setStatus('ready');
    } catch{
      showFailure('Teagram.Registration.SecurityCheckUnavailable');
    }
  }

  function retry() {
    if(api && widgetId) {
      setFailure(undefined);
      setStatus('ready');
      api.reset(widgetId);
    } else {
      void loadWidget();
    }
  }

  onMount(() => void loadWidget());

  onCleanup(() => {
    disposed = true;
    if(api && widgetId) api.remove(widgetId);
  });

  return (
    <div
      class={styles.turnstileChallenge}
      data-testid="turnstile-challenge"
      data-sitekey={props.siteKey}
      aria-label={i18n('Teagram.Registration.SecurityCheck').textContent || 'Security check'}
    >
      <div ref={container} class={styles.turnstileWidget}/>
      {status() === 'loading' && <div role="status" aria-live="polite">{i18n('Teagram.Registration.SecurityCheckLoading')}</div>}
      {status() === 'checking' && <div role="status" aria-live="polite">{i18n('Teagram.Registration.SecurityCheckChecking')}</div>}
      {failure() && <div class={styles.errorLabel} role="alert">{i18n(failure())}</div>}
      {status() === 'retry' && (
        <Button class="btn-secondary" onClick={retry}>
          {i18n('Teagram.Registration.SecurityCheckRetry')}
        </Button>
      )}
    </div>
  );
}

function loadTurnstile(): Promise<TurnstileApi> {
  const turnstileWindow = window as TurnstileWindow;
  if(turnstileWindow.turnstile) return Promise.resolve(turnstileWindow.turnstile);
  if(turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;

    let settled = false;
    const timeoutId = window.setTimeout(() => fail(), 15000);
    const fail = () => {
      if(settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      script.remove();
      turnstileScriptPromise = undefined;
      reject(new Error('Turnstile script failed to load'));
    };

    script.onload = () => {
      const api = turnstileWindow.turnstile;
      if(!api) {
        fail();
        return;
      }

      if(settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve(api);
    };
    script.onerror = fail;
    document.head.append(script);
  });

  return turnstileScriptPromise;
}
