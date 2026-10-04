import type {AuthSendCode, AuthSignIn, User} from '@layer';
import App from '@config/app';
import {isPrivateUsernameCredentialError} from '@/pages/privateUsernameLoginState';

export {isPrivateUsernameCredentialError} from '@/pages/privateUsernameLoginState';

const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

export type PrivateUsernameAuthResult =
  | {kind: 'invalidInput'}
  | {kind: 'invalidCredentials'}
  | {kind: 'password'}
  | {kind: 'authorized', user: User}
  | {kind: 'cancelled'}
  | {kind: 'error'};

type InvokeAuthApi = (
  method: 'auth.sendCode' | 'auth.signIn',
  params: AuthSendCode | AuthSignIn,
  options?: {ignoreErrors: true}
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getErrorType(error: unknown): unknown {
  return isRecord(error) ? error.type : undefined;
}

export function isPrivateUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export async function authenticatePrivateUsername(
  username: string,
  invokeApi: InvokeAuthApi,
  isCancelled: () => boolean = () => false
): Promise<PrivateUsernameAuthResult> {
  if(!isPrivateUsername(username)) return {kind: 'invalidInput'};

  let sentCode: unknown;
  try {
    sentCode = await invokeApi('auth.sendCode', {
      phone_number: username,
      api_id: App.id,
      api_hash: App.hash,
      settings: {
        _: 'codeSettings',
        pFlags: {}
      }
    });
  } catch(error) {
    if(isCancelled()) return {kind: 'cancelled'};
    return isPrivateUsernameCredentialError(error) ? {kind: 'invalidCredentials'} : {kind: 'error'};
  }

  if(isCancelled()) return {kind: 'cancelled'};
  if(!isRecord(sentCode)) return {kind: 'error'};
  if(sentCode._ === 'auth.authorizationSignUpRequired') return {kind: 'invalidCredentials'};
  if(sentCode._ !== 'auth.sentCode' || typeof sentCode.phone_code_hash !== 'string' || !sentCode.phone_code_hash) {
    return {kind: 'error'};
  }

  let authorization: unknown;
  try {
    authorization = await invokeApi('auth.signIn', {
      phone_number: username,
      phone_code_hash: sentCode.phone_code_hash,
      phone_code: ''
    }, {ignoreErrors: true});
  } catch(error) {
    if(isCancelled()) return {kind: 'cancelled'};
    if(getErrorType(error) === 'SESSION_PASSWORD_NEEDED') return {kind: 'password'};
    return isPrivateUsernameCredentialError(error) ? {kind: 'invalidCredentials'} : {kind: 'error'};
  }

  if(isCancelled()) return {kind: 'cancelled'};
  if(!isRecord(authorization)) return {kind: 'error'};
  if(authorization._ === 'auth.authorizationSignUpRequired') return {kind: 'invalidCredentials'};
  if(authorization._ !== 'auth.authorization' || !isRecord(authorization.user)) return {kind: 'error'};

  return {kind: 'authorized', user: authorization.user as User};
}
