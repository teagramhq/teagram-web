import type {AuthCheckPassword, AuthSendCode, AuthSignUp, InvokeWithReCaptcha} from '@layer';

export type TurnstileAction = 'signin' | 'signup';
export type TurnstileAuthMethod = 'auth.sendCode' | 'auth.checkPassword' | 'auth.signUp';
export type TurnstileAuthParams = AuthSendCode | AuthCheckPassword | AuthSignUp;

export type InvokeTurnstileApi<TResponse = unknown> = (
  method: TurnstileAuthMethod | 'invokeWithReCaptcha',
  params: TurnstileAuthParams | InvokeWithReCaptcha
) => Promise<TResponse>;

export type RequestTurnstileChallenge = (
  siteKey: string,
  action: TurnstileAction,
  submit: (token: string) => Promise<unknown>
) => Promise<unknown>;

type GetTurnstileAuthParams = () => TurnstileAuthParams | Promise<TurnstileAuthParams>;

export function getTurnstileSiteKey(error: unknown, action?: TurnstileAction): string | undefined {
  if(!error || typeof error !== 'object') return;

  const type = (error as {type?: unknown}).type;
  if(typeof type !== 'string') return;

  const match = /^RECAPTCHA_CHECK_(signin|signup)__([A-Za-z0-9_-]{1,256})$/.exec(type);
  if(!match || (action && match[1] !== action)) return;
  return match[2];
}

export async function invokeTurnstileProtected<TResponse = unknown>(
  invokeApi: InvokeTurnstileApi<TResponse>,
  method: TurnstileAuthMethod,
  params: TurnstileAuthParams | GetTurnstileAuthParams,
  action: TurnstileAction,
  requestChallenge?: RequestTurnstileChallenge,
  siteKey?: string
): Promise<TResponse> {
  const getParams = typeof params === 'function' ? params : () => params;
  const submit = async(token?: string) => {
    const currentParams = await getParams();
    if(token === undefined) return await invokeApi(method, currentParams);

    return await invokeApi('invokeWithReCaptcha', {
      token,
      query: {_: method, ...currentParams}
    });
  };

  if(action === 'signup' && siteKey && requestChallenge) {
    return await requestChallenge(siteKey, action, (token) => submit(token)) as TResponse;
  }

  try {
    return await submit();
  } catch(error) {
    const challengeSiteKey = getTurnstileSiteKey(error, action);
    if(!challengeSiteKey || !requestChallenge) throw error;

    return await requestChallenge(challengeSiteKey, action, (token) => submit(token)) as TResponse;
  }
}

export function invokeSignUpWithTurnstile<TResponse = unknown>(
  invokeApi: InvokeTurnstileApi<TResponse>,
  params: AuthSignUp,
  requestChallenge?: RequestTurnstileChallenge,
  siteKey?: string
): Promise<TResponse> {
  return invokeTurnstileProtected(invokeApi, 'auth.signUp', params, 'signup', requestChallenge, siteKey);
}
