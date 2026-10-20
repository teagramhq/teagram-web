import type {AuthSignUp, InvokeWithReCaptcha} from '@layer';

export type InvokeSignUpApi<TResponse = unknown> = (
  method: 'auth.signUp' | 'invokeWithReCaptcha',
  params: AuthSignUp | InvokeWithReCaptcha
) => Promise<TResponse>;

export type RequestTurnstileChallenge = (
  siteKey: string,
  submit: (token: string) => Promise<unknown>
) => Promise<unknown>;

export function getTurnstileSiteKey(error: unknown): string | undefined {
  if(!error || typeof error !== 'object') return;

  const type = (error as {type?: unknown}).type;
  if(typeof type !== 'string') return;

  const match = /^RECAPTCHA_CHECK_signup__([A-Za-z0-9_-]{1,256})$/.exec(type);
  return match?.[1];
}

export async function invokeSignUpWithTurnstile<TResponse = unknown>(
  invokeApi: InvokeSignUpApi<TResponse>,
  params: AuthSignUp,
  requestChallenge?: RequestTurnstileChallenge
): Promise<TResponse> {
  try {
    return await invokeApi('auth.signUp', params);
  } catch(error) {
    const siteKey = getTurnstileSiteKey(error);
    if(!siteKey || !requestChallenge) throw error;

    return await requestChallenge(siteKey, (token) => invokeApi('invokeWithReCaptcha', {
      token,
      query: {_: 'auth.signUp', ...params}
    })) as TResponse;
  }
}
