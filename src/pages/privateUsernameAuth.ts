import type {AuthCheckPassword, AuthSendCode, AuthSignIn, AuthSignUp, InvokeWithReCaptcha, User} from '@layer';
import App from '@config/app';
import {isPrivateUsernameCredentialError} from '@/pages/privateUsernameLoginState';
import {invokeSignUpWithTurnstile, invokeTurnstileProtected} from '@/pages/turnstileSignup';
import type {RequestTurnstileChallenge} from '@/pages/turnstileSignup';

export {isPrivateUsernameCredentialError} from '@/pages/privateUsernameLoginState';

const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

export type PrivateUsernameAuthResult =
  | {kind: 'invalidInput'}
  | {kind: 'invalidCredentials'}
  | {kind: 'usernameTaken'}
  | {kind: 'invalidUsername'}
  | {kind: 'invalidDisplayName'}
  | {kind: 'invalidInvite'}
  | {kind: 'registrationClosed'}
  | {kind: 'weakPassword', user: User}
  | {kind: 'passwordSetupError', user: User, errorType?: string}
  | {kind: 'password'}
  | {kind: 'authorized', user: User}
  | {kind: 'cancelled'}
  | {kind: 'error', errorType?: string};

export type PrivateUsernameRegistrationMode = 'closed' | 'invite' | 'open';

export type PrivateUsernameRegistration = {
  mode: PrivateUsernameRegistrationMode,
  displayName: string,
  password: string,
  inviteSecret?: string,
  updatePasswordSettings: (password: string) => Promise<unknown>,
  onAuthorization?: (user: User) => Promise<void>,
  checkPassword?: (password: string) => Promise<User | false | undefined>
};

export type PrivateUsernameRegistrationError = 'usernameTaken' | 'invalidUsername' | 'invalidDisplayName' | 'invalidInvite' | 'registrationClosed' | 'weakPassword' | 'error';

type InvokeAuthApi = (
  method: 'auth.sendCode' | 'auth.signIn' | 'auth.checkPassword' | 'auth.signUp' | 'invokeWithReCaptcha',
  params: AuthSendCode | AuthSignIn | AuthCheckPassword | AuthSignUp | InvokeWithReCaptcha,
  options?: {ignoreErrors: true}
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getErrorType(error: unknown): unknown {
  return isRecord(error) ? error.type : undefined;
}

function getAuthErrorResult(error: unknown, includeType: boolean): PrivateUsernameAuthResult {
  const errorType = getErrorType(error);
  const shouldIncludeType = includeType || errorType === 'AUTH_KEY_UNKNOWN' || errorType === 'AUTH_KEY_RATE_LIMIT';
  return shouldIncludeType && typeof errorType === 'string' ? {kind: 'error', errorType} : {kind: 'error'};
}

function wasCancelled(error: unknown, isCancelled: () => boolean) {
  return isCancelled() || (isRecord(error) && (error.type === 'GUEST_CANCELLED' || error.name === 'AbortError' ||
    error.message === 'Turnstile challenge cancelled'));
}

export function isPrivateUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export function getPrivateUsernameRegistrationError(error: unknown): PrivateUsernameRegistrationError {
  switch(getErrorType(error)) {
    case 'USERNAME_OCCUPIED':
      return 'usernameTaken';
    case 'USERNAME_INVALID':
      return 'invalidUsername';
    case 'FIRSTNAME_INVALID':
    case 'LASTNAME_INVALID':
      return 'invalidDisplayName';
    case 'INVITE_HASH_INVALID':
      return 'invalidInvite';
    case 'INPUT_REQUEST_INVALID':
      return 'registrationClosed';
    case 'PASSWORD_TOO_WEAK':
    case 'NEW_PASSWORD_BAD':
    case 'NEW_SALT_INVALID':
      return 'weakPassword';
    default:
      return 'error';
  }
}

export async function authenticatePrivateUsername(
  username: string,
  invokeApi: InvokeAuthApi,
  isCancelled: () => boolean = () => false,
  registration?: PrivateUsernameRegistration,
  requestTurnstile?: RequestTurnstileChallenge,
  turnstileSiteKey?: string
): Promise<PrivateUsernameAuthResult> {
  if(!isPrivateUsername(username)) return {kind: 'invalidInput'};
  if(registration && registration.mode !== 'closed' && !registration.displayName.trim()) return {kind: 'invalidInput'};
  if(registration && registration.mode !== 'closed' && !registration.password) return {kind: 'invalidInput'};
  if(registration?.mode === 'invite' && !registration.inviteSecret?.trim()) return {kind: 'invalidInput'};

  let sentCode: unknown;
  try {
    sentCode = await invokeTurnstileProtected(invokeApi, 'auth.sendCode', {
      phone_number: username,
      api_id: App.id,
      api_hash: App.hash,
      settings: {
        _: 'codeSettings',
        pFlags: {}
      }
    }, 'signin', requestTurnstile);
  } catch(error) {
    if(wasCancelled(error, isCancelled)) return {kind: 'cancelled'};
    return isPrivateUsernameCredentialError(error) ? {kind: 'invalidCredentials'} : getAuthErrorResult(error, !!registration);
  }

  if(isCancelled()) return {kind: 'cancelled'};
  if(!isRecord(sentCode)) return {kind: 'error'};
  if(sentCode._ === 'auth.authorizationSignUpRequired') return {kind: 'invalidCredentials'};
  if(sentCode._ !== 'auth.sentCode' || typeof sentCode.phone_code_hash !== 'string' || !sentCode.phone_code_hash) {
    return {kind: 'error'};
  }

  let authorization: unknown;
  try {
    const phoneCode = registration?.mode === 'invite' ? registration.inviteSecret : '';
    authorization = await invokeApi('auth.signIn', {
      phone_number: username,
      phone_code_hash: sentCode.phone_code_hash,
      phone_code: phoneCode
    }, {ignoreErrors: true});
  } catch(error) {
    if(wasCancelled(error, isCancelled)) return {kind: 'cancelled'};
    if(getErrorType(error) === 'SESSION_PASSWORD_NEEDED') {
      if(registration?.checkPassword) {
        try {
          const user = await registration.checkPassword(registration.password);
          if(!user) return {kind: 'usernameTaken'};
          if(isCancelled()) return {kind: 'cancelled'};
          await registration.onAuthorization?.(user);
          return {kind: 'authorized', user};
        } catch(checkError) {
          if(wasCancelled(checkError, isCancelled)) return {kind: 'cancelled'};
          return getAuthErrorResult(checkError, true);
        }
      }
      return registration ? {kind: 'usernameTaken'} : {kind: 'password'};
    }
    return isPrivateUsernameCredentialError(error) ? {kind: 'invalidCredentials'} : getAuthErrorResult(error, !!registration);
  }

  if(isCancelled()) return {kind: 'cancelled'};
  if(!isRecord(authorization)) return {kind: 'error'};
  if(authorization._ === 'auth.authorizationSignUpRequired') {
    if(!registration || registration.mode === 'closed') return {kind: 'invalidCredentials'};

    let signUpResponse: unknown;
    try {
      const params: AuthSignUp = {
        phone_number: username,
        phone_code_hash: sentCode.phone_code_hash,
        first_name: registration.displayName.trim(),
        last_name: ''
      };
      signUpResponse = await invokeSignUpWithTurnstile(
        (method, request) => invokeApi(method, request),
        params,
        requestTurnstile,
        turnstileSiteKey
      );
    } catch(error) {
      if(wasCancelled(error, isCancelled)) return {kind: 'cancelled'};
      const errorKind = getPrivateUsernameRegistrationError(error);
      return errorKind === 'weakPassword' || errorKind === 'error' ? getAuthErrorResult(error, true) : {kind: errorKind};
    }

    if(!isRecord(signUpResponse) || signUpResponse._ !== 'auth.authorization' || !isRecord(signUpResponse.user)) {
      return {kind: 'error'};
    }

    const user = signUpResponse.user as User;
    try {
      await registration.onAuthorization?.(user);
    } catch(error) {
      if(wasCancelled(error, isCancelled)) return {kind: 'cancelled'};
      return getAuthErrorResult(error, true);
    }

    if(isCancelled()) return {kind: 'cancelled'};
    let passwordSettingsSaved: unknown;
    try {
      passwordSettingsSaved = await registration.updatePasswordSettings(registration.password);
    } catch(error) {
      if(wasCancelled(error, isCancelled)) return {kind: 'cancelled'};
      const errorKind = getPrivateUsernameRegistrationError(error);
      if(errorKind === 'weakPassword') return {kind: 'weakPassword', user};
      const errorType = getErrorType(error);
      return typeof errorType === 'string' ? {kind: 'passwordSetupError', user, errorType} : {kind: 'passwordSetupError', user};
    }

    if(isCancelled()) return {kind: 'cancelled'};
    if(passwordSettingsSaved === false) return {kind: 'passwordSetupError', user};
    return {kind: 'authorized', user};
  }

  if(authorization._ !== 'auth.authorization' || !isRecord(authorization.user)) return {kind: 'error'};
  if(registration) return {kind: 'usernameTaken'};

  return {kind: 'authorized', user: authorization.user as User};
}
