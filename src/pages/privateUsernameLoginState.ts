let privateUsernameLogin = false;
const CREDENTIAL_ERROR_TYPES = new Set([
  'PHONE_NUMBER_INVALID',
  'INPUT_REQUEST_INVALID',
  'PASSWORD_HASH_INVALID'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isPrivateUsernameCredentialError(error: unknown): boolean {
  return isRecord(error) && CREDENTIAL_ERROR_TYPES.has(error.type as string);
}

export function markPrivateUsernameLogin(): void {
  privateUsernameLogin = true;
}

export function isPrivateUsernameLogin(): boolean {
  return privateUsernameLogin;
}

export function clearPrivateUsernameLogin(): void {
  privateUsernameLogin = false;
}
