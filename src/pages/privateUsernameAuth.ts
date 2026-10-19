import type {AuthSendCode, AuthSignIn, AuthSignUp, User} from '@layer';
import App from '@config/app';
import {isPrivateUsernameCredentialError} from '@/pages/privateUsernameLoginState';

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
  | {kind: 'passwordSetupError', user: User}
  | {kind: 'password'}
  | {kind: 'authorized', user: User}
  | {kind: 'cancelled'}
  | {kind: 'error'};

export type PrivateUsernameRegistrationMode = 'closed' | 'invite' | 'open';

export type PrivateUsernameRegistration = {
  mode: PrivateUsernameRegistrationMode,
  displayName: string,
  password: string,
  inviteSecret?: string,
  updatePasswordSettings: (password: string) => Promise<unknown>
};

export type PrivateUsernameRegistrationError = 'usernameTaken' | 'invalidUsername' | 'invalidDisplayName' | 'invalidInvite' | 'registrationClosed' | 'weakPassword' | 'error';

type InvokeAuthApi = (
  method: 'auth.sendCode' | 'auth.signIn' | 'auth.signUp',
  params: AuthSendCode | AuthSignIn | AuthSignUp,
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
  registration?: PrivateUsernameRegistration
): Promise<PrivateUsernameAuthResult> {
  if(!isPrivateUsername(username)) return {kind: 'invalidInput'};
  if(registration && registration.mode !== 'closed' && !registration.displayName.trim()) return {kind: 'invalidInput'};
  if(registration && registration.mode !== 'closed' && !registration.password) return {kind: 'invalidInput'};
  if(registration?.mode === 'invite' && !registration.inviteSecret?.trim()) return {kind: 'invalidInput'};

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
    const phoneCode = registration?.mode === 'invite' ? registration.inviteSecret : '';
    authorization = await invokeApi('auth.signIn', {
      phone_number: username,
      phone_code_hash: sentCode.phone_code_hash,
      phone_code: phoneCode
    }, {ignoreErrors: true});
  } catch(error) {
    if(isCancelled()) return {kind: 'cancelled'};
    if(getErrorType(error) === 'SESSION_PASSWORD_NEEDED') return registration ? {kind: 'usernameTaken'} : {kind: 'password'};
    return isPrivateUsernameCredentialError(error) ? {kind: 'invalidCredentials'} : {kind: 'error'};
  }

  if(isCancelled()) return {kind: 'cancelled'};
  if(!isRecord(authorization)) return {kind: 'error'};
  if(authorization._ === 'auth.authorizationSignUpRequired') {
    if(!registration || registration.mode === 'closed') return {kind: 'invalidCredentials'};

    let signUpResponse: unknown;
    try {
      signUpResponse = await invokeApi('auth.signUp', {
        phone_number: username,
        phone_code_hash: sentCode.phone_code_hash,
        first_name: registration.displayName.trim(),
        last_name: ''
      });
    } catch(error) {
      if(isCancelled()) return {kind: 'cancelled'};
      const errorKind = getPrivateUsernameRegistrationError(error);
      return {kind: errorKind === 'weakPassword' ? 'error' : errorKind};
    }

    if(!isRecord(signUpResponse) || signUpResponse._ !== 'auth.authorization' || !isRecord(signUpResponse.user)) {
      return {kind: 'error'};
    }

    const user = signUpResponse.user as User;
    let passwordSettingsSaved: unknown;
    try {
      passwordSettingsSaved = await registration.updatePasswordSettings(registration.password);
    } catch(error) {
      if(isCancelled()) return {kind: 'cancelled'};
      const errorKind = getPrivateUsernameRegistrationError(error);
      if(errorKind === 'weakPassword') return {kind: 'weakPassword', user};
      return {kind: 'passwordSetupError', user};
    }

    if(isCancelled()) return {kind: 'cancelled'};
    if(passwordSettingsSaved === false) return {kind: 'passwordSetupError', user};
    return {kind: 'authorized', user};
  }

  if(authorization._ !== 'auth.authorization' || !isRecord(authorization.user)) return {kind: 'error'};
  if(registration) return {kind: 'usernameTaken'};

  return {kind: 'authorized', user: authorization.user as User};
}
