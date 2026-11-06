export type TurnstileRenderOptions = {
  sitekey: string,
  action: string,
  'response-field'?: boolean,
  callback: (token: string) => void,
  'expired-callback': () => void,
  'error-callback': () => void
};

export type TurnstileApi = {
  render: (container: HTMLElement, callbacks: TurnstileRenderOptions) => string,
  reset: (widgetId: string) => void,
  remove: (widgetId: string) => void
};

export type TurnstileWindow = Window & {turnstile?: TurnstileApi};

const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TURNSTILE_LOAD_TIMEOUT = 15000;
let turnstileScriptPromise: Promise<TurnstileApi> | undefined;

export function loadTurnstile(): Promise<TurnstileApi> {
  const turnstileWindow = window as TurnstileWindow;
  if(turnstileWindow.turnstile) return Promise.resolve(turnstileWindow.turnstile);
  if(turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;

    let settled = false;
    const timeoutId = window.setTimeout(() => fail(), TURNSTILE_LOAD_TIMEOUT);
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
      turnstileScriptPromise = undefined;
      resolve(api);
    };
    script.onerror = fail;
    document.head.append(script);
  });

  return turnstileScriptPromise;
}
