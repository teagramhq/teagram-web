import type {AuthCheckPassword, AuthSendCode, AuthSignIn, AuthSignUp, HelpTermsOfService, InvokeWithReCaptcha, User} from '@layer';
import App from '@config/app';
import type {MTAppConfig} from '@/appConfig';
import {isPrivateUsernameCredentialError} from '@/pages/privateUsernameLoginState';
import {invokeSignUpWithTurnstile, invokeTurnstileProtected} from '@/pages/turnstileSignup';
import type {RequestTurnstileChallenge} from '@/pages/turnstileSignup';
import {isUsernameValid} from '@lib/richTextProcessor/validators';
import {parsePrivateUsernameInviteSecret} from '@/pages/privateUsernameInvite';

export {isPrivateUsernameCredentialError} from '@/pages/privateUsernameLoginState';
export {parsePrivateUsernameInviteSecret} from '@/pages/privateUsernameInvite';

export type PrivateUsernameAuthResult =
  | {kind: 'invalidInput'}
  | {kind: 'invalidCredentials'}
  | {kind: 'usernameTaken'}
  | {kind: 'invalidUsername'}
  | {kind: 'invalidDisplayName'}
  | {kind: 'invalidInvite'}
  | {kind: 'registrationClosed'}
  | {kind: 'termsDeclined'}
  | {kind: 'termsAcceptanceError', errorType?: string}
  | {kind: 'passwordSetupError', user: User, errorType?: string}
  | {kind: 'password'}
  | {kind: 'authorized', user: User}
  | {kind: 'cancelled'}
  | {kind: 'error', errorType?: string, authKeyRecoveryFailed?: true};

export type PrivateUsernameRegistrationMode = 'closed' | 'invite' | 'open';

export type PrivateUsernameRegistration = {
  mode: PrivateUsernameRegistrationMode,
  displayName: string,
  password: string,
  inviteSecret?: string,
  updatePasswordSettings: (password: string) => Promise<unknown>,
  requestTermsAcceptance?: (terms: HelpTermsOfService) => Promise<boolean>,
  onAuthorization?: (user: User, isNewAccount: boolean) => Promise<void>,
  checkPassword?: (password: string) => Promise<User | false | undefined>
};

export type PrivateUsernameRegistrationError = 'usernameTaken' | 'invalidUsername' | 'invalidDisplayName' | 'invalidInvite' | 'registrationClosed' | 'error';

type InvokeAuthApi = (
  method: 'auth.sendCode' | 'auth.signIn' | 'auth.checkPassword' | 'auth.signUp' | 'invokeWithReCaptcha',
  params: AuthSendCode | AuthSignIn | AuthCheckPassword | AuthSignUp | InvokeWithReCaptcha,
  options?: {ignoreErrors?: true, authKeyRecovery?: true}
) => Promise<unknown>;

export type RecoverPrivateUsernameAuthKey = (error: unknown, shouldRecover: boolean) => Promise<boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getErrorType(error: unknown): unknown {
  return isRecord(error) ? error.type : undefined;
}

function getAuthErrorResult(error: unknown, includeType: boolean, authKeyRecoveryFailed = false): PrivateUsernameAuthResult {
  if(authKeyRecoveryFailed) return {kind: 'error', authKeyRecoveryFailed: true};
  const errorType = getErrorType(error);
  const shouldIncludeType = includeType || errorType === 'AUTH_KEY_UNKNOWN' || errorType === 'AUTH_KEY_RATE_LIMIT';
  return shouldIncludeType && typeof errorType === 'string' ? {kind: 'error', errorType} : {kind: 'error'};
}

function wasCancelled(error: unknown, isCancelled: () => boolean) {
  return isCancelled() || (isRecord(error) && (error.type === 'GUEST_CANCELLED' || error.name === 'AbortError' ||
    error.message === 'Turnstile challenge cancelled'));
}

export function isPrivateUsername(username: string, appConfig?: Partial<MTAppConfig>): boolean {
  return isUsernameValid(username, appConfig);
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
  turnstileSiteKey?: string,
  recoverAuthKey?: RecoverPrivateUsernameAuthKey,
  appConfig?: MTAppConfig
): Promise<PrivateUsernameAuthResult> {
  if(!isPrivateUsername(username, appConfig)) return {kind: 'invalidInput'};
  if(registration && registration.mode !== 'closed' && !registration.displayName.trim()) return {kind: 'invalidInput'};
  if(registration && registration.mode !== 'closed' && !registration.password) return {kind: 'invalidInput'};
  const inviteSecret = registration?.mode === 'invite' ? parsePrivateUsernameInviteSecret(registration.inviteSecret || '') : undefined;
  if(registration?.mode === 'invite' && !inviteSecret) return {kind: 'invalidInput'};

  let didRecoverAuthKey = false;
  let authKeyRecoveryFailed = false;
  const invokeAuthApi = async(
    method: Parameters<InvokeAuthApi>[0],
    params: Parameters<InvokeAuthApi>[1],
    options?: Parameters<InvokeAuthApi>[2]
  ) => {
    const requestOptions: Parameters<InvokeAuthApi>[2] = recoverAuthKey ? {...options, authKeyRecovery: true as const} : options;
    const invoke = () => requestOptions ? invokeApi(method, params, requestOptions) : invokeApi(method, params);

    try {
      return await invoke();
    } catch(error) {
      if(getErrorType(error) !== 'AUTH_KEY_UNKNOWN' || !recoverAuthKey) throw error;

      const shouldRecover = !didRecoverAuthKey && !wasCancelled(error, isCancelled);
      if(shouldRecover) didRecoverAuthKey = true;
      let recovered: boolean;
      try {
        recovered = await recoverAuthKey(error, shouldRecover);
      } catch(recoveryError) {
        authKeyRecoveryFailed = true;
        throw recoveryError;
      }
      if(!shouldRecover || !recovered || isCancelled()) throw error;

      try {
        return await invoke();
      } catch(retryError) {
        if(getErrorType(retryError) === 'AUTH_KEY_UNKNOWN') {
          try {
            await recoverAuthKey(retryError, false);
          } catch(recoveryError) {
            authKeyRecoveryFailed = true;
            throw recoveryError;
          }
        }
        throw retryError;
      }
    }
  };

  let sentCode: unknown;
  try {
    sentCode = await invokeTurnstileProtected(invokeAuthApi, 'auth.sendCode', {
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
    if(authKeyRecoveryFailed) return getAuthErrorResult(error, !!registration, true);
    const errorKind = getPrivateUsernameRegistrationError(error);
    if(errorKind === 'usernameTaken' || errorKind === 'invalidUsername') return {kind: errorKind};
    return isPrivateUsernameCredentialError(error) ? {kind: 'invalidCredentials'} : getAuthErrorResult(error, !!registration, authKeyRecoveryFailed);
  }

  if(isCancelled()) return {kind: 'cancelled'};
  if(!isRecord(sentCode)) return {kind: 'error'};
  if(sentCode._ === 'auth.authorizationSignUpRequired') return {kind: 'invalidCredentials'};
  if(sentCode._ !== 'auth.sentCode' || typeof sentCode.phone_code_hash !== 'string' || !sentCode.phone_code_hash) {
    return {kind: 'error'};
  }

  let authorization: unknown;
  try {
    const phoneCode = registration?.mode === 'invite' ? inviteSecret : '';
    authorization = await invokeAuthApi('auth.signIn', {
      phone_number: username,
      phone_code_hash: sentCode.phone_code_hash,
      phone_code: phoneCode
    }, {ignoreErrors: true});
  } catch(error) {
    if(wasCancelled(error, isCancelled)) return {kind: 'cancelled'};
    if(authKeyRecoveryFailed) return getAuthErrorResult(error, !!registration, true);
    const errorKind = getPrivateUsernameRegistrationError(error);
    if(errorKind === 'usernameTaken' || errorKind === 'invalidUsername') return {kind: errorKind};
    if(getErrorType(error) === 'SESSION_PASSWORD_NEEDED') {
      if(registration?.checkPassword) {
        try {
          const user = await registration.checkPassword(registration.password);
          if(!user) return {kind: 'usernameTaken'};
          if(isCancelled()) return {kind: 'cancelled'};
          await registration.onAuthorization?.(user, false);
          return {kind: 'authorized', user};
        } catch(checkError) {
          if(getErrorType(checkError) === 'GUEST_CONTEXT_CHANGED') return getAuthErrorResult(checkError, true);
          if(wasCancelled(checkError, isCancelled)) return {kind: 'cancelled'};
          return getAuthErrorResult(checkError, true);
        }
      }
      return registration ? {kind: 'usernameTaken'} : {kind: 'password'};
    }
    return isPrivateUsernameCredentialError(error) ? {kind: 'invalidCredentials'} : getAuthErrorResult(error, !!registration, authKeyRecoveryFailed);
  }

  if(isCancelled()) return {kind: 'cancelled'};
  if(!isRecord(authorization)) return {kind: 'error'};
  if(authorization._ === 'auth.authorizationSignUpRequired') {
    if(!registration || registration.mode === 'closed') return {kind: 'invalidCredentials'};

    const terms = authorization.terms_of_service;
    if(isRecord(terms) && typeof terms.text === 'string' && terms.text.trim()) {
      if(!registration.requestTermsAcceptance) return {kind: 'termsDeclined'};
      let accepted: boolean;
      try {
        accepted = await registration.requestTermsAcceptance(terms as unknown as HelpTermsOfService);
      } catch(error) {
        if(wasCancelled(error, isCancelled)) return {kind: 'cancelled'};
        const errorType = getErrorType(error);
        return typeof errorType === 'string' ? {kind: 'termsAcceptanceError', errorType} : {kind: 'termsAcceptanceError'};
      }
      if(isCancelled()) return {kind: 'cancelled'};
      if(!accepted) return {kind: 'termsDeclined'};
    }

    let signUpResponse: unknown;
    try {
      const params: AuthSignUp = {
        phone_number: username,
        phone_code_hash: sentCode.phone_code_hash,
        first_name: registration.displayName.trim(),
        last_name: ''
      };
      signUpResponse = await invokeSignUpWithTurnstile(
        (method, request) => invokeAuthApi(method, request),
        params,
        requestTurnstile,
        turnstileSiteKey
      );
    } catch(error) {
      if(wasCancelled(error, isCancelled)) return {kind: 'cancelled'};
      if(authKeyRecoveryFailed) return getAuthErrorResult(error, true, true);
      const errorKind = getPrivateUsernameRegistrationError(error);
      return errorKind === 'error' ? getAuthErrorResult(error, true) : {kind: errorKind};
    }

    if(!isRecord(signUpResponse) || signUpResponse._ !== 'auth.authorization' || !isRecord(signUpResponse.user)) {
      return {kind: 'error'};
    }

    const user = signUpResponse.user as User;
    try {
      await registration.onAuthorization?.(user, true);
    } catch(error) {
      if(getErrorType(error) === 'GUEST_CONTEXT_CHANGED') return getAuthErrorResult(error, true);
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
