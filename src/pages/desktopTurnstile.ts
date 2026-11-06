import styles from '@/pages/authFlow.module.scss';
import {loadTurnstile} from '@lib/turnstile';
import type {TurnstileApi, TurnstileWindow} from '@lib/turnstile';
import type {TurnstileAction} from '@/pages/turnstileSignup';

type TurnstileErrorCode = 'bad_params' | 'expired' | 'widget_error';
type TurnstileEvent = 'turnstile_error' | 'turnstile_token';

type DesktopTurnstileWindow = TurnstileWindow & {
  TelegramWebviewProxy?: {
    postEvent: (event: TurnstileEvent, payload: string) => void
  }
};

const MESSAGES = {
  openDesktop: 'Open this security check from Teagram Desktop.',
  loading: 'Loading security check…',
  checking: 'Checking…',
  failed: 'The security check failed. Try again.',
  expired: 'The security check expired. Try again.',
  unavailable: 'The security check couldn’t load. Try again.'
};

export function mountDesktopTurnstilePage() {
  const pageWindow = window as DesktopTurnstileWindow;
  const message = document.getElementById('turnstile-message')!;
  const widgetContainer = document.getElementById('turnstile-widget')!;
  const params = new URLSearchParams(pageWindow.location.hash.slice(1));
  const sitekey = params.get('sitekey');
  const sitekeyMatch = sitekey && /^[A-Za-z0-9_-]{1,256}$/.exec(sitekey);
  const rawAction = params.get('action');
  const action = rawAction === 'signin' || rawAction === 'signup' ? rawAction : undefined;
  const bridge = pageWindow.TelegramWebviewProxy;

  function showStatus(text: string) {
    message.classList.remove(styles.errorLabel);
    message.classList.add(styles.registrationConfigError);
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    message.hidden = !text;
    message.textContent = text;
  }

  function showError(text: string) {
    message.classList.remove(styles.registrationConfigError);
    message.classList.add(styles.errorLabel);
    message.setAttribute('role', 'alert');
    message.setAttribute('aria-live', 'assertive');
    message.hidden = false;
    message.textContent = text;
  }

  if(!sitekeyMatch || sitekeyMatch[0] !== sitekey || !action) {
    showError(MESSAGES.failed);
    if(typeof bridge?.postEvent === 'function') {
      try {
        bridge.postEvent('turnstile_error', JSON.stringify({code: 'bad_params' satisfies TurnstileErrorCode}));
      } catch{
        showError(MESSAGES.unavailable);
      }
    }
    return;
  }

  if(typeof bridge?.postEvent !== 'function') {
    showStatus(MESSAGES.openDesktop);
    return;
  }

  let api: TurnstileApi | undefined;
  let widgetId: string | undefined;
  let completed = false;

  function sendEvent(event: TurnstileEvent, payload: string) {
    try {
      bridge.postEvent(event, payload);
    } catch{
      showError(MESSAGES.unavailable);
    }
  }

  function reportError(code: TurnstileErrorCode, text: string) {
    if(completed) return;

    showError(text);
    if(api && widgetId) {
      try {
        api.reset(widgetId);
      } catch{
        showError(MESSAGES.unavailable);
      }
    }

    sendEvent('turnstile_error', JSON.stringify({code}));
  }

  function handleToken(token: string) {
    if(completed) return;
    completed = true;
    showStatus(MESSAGES.checking);

    if(api && widgetId) {
      try {
        api.remove(widgetId);
      } catch{
        showError(MESSAGES.unavailable);
      }
    }

    widgetContainer.replaceChildren();
    sendEvent('turnstile_token', JSON.stringify({token, action}));
  }

  function renderWidget(turnstile: TurnstileApi) {
    api = turnstile;
    showStatus('');

    try {
      widgetId = turnstile.render(widgetContainer, {
        sitekey,
        action,
        'response-field': false,
        callback: handleToken,
        'expired-callback': () => reportError('expired', MESSAGES.expired),
        'error-callback': () => reportError('widget_error', MESSAGES.failed)
      });
    } catch{
      reportError('widget_error', MESSAGES.unavailable);
    }
  }

  const existingApi = pageWindow.turnstile;
  if(existingApi) {
    renderWidget(existingApi);
    return;
  }

  showStatus(MESSAGES.loading);
  void loadTurnstile().then(renderWidget, () => reportError('widget_error', MESSAGES.unavailable));
}
