export type QrFixtureOutcome = 'input-method-invalid' | 'network-bad-response-406' | 'token';

export const QR_FIXTURE_REFUSAL_MESSAGE = 'Synthetic QR fixture refused to mount';

const isForbiddenAuthKey = (key: string) => key.startsWith('account') ||
  /^dc\d+_(auth_key|server_salt)$/.test(key) ||
  key === 'user_auth' ||
  key === 'preview_auth_seeded';

export function getQrFixtureMountRefusal(
  isPreview: boolean,
  localStorageKeys: string[] | undefined,
  sessionStorageKeys: string[] | undefined
) {
  if(isPreview || !localStorageKeys || !sessionStorageKeys) {
    return QR_FIXTURE_REFUSAL_MESSAGE;
  }

  return [...localStorageKeys, ...sessionStorageKeys].some(isForbiddenAuthKey) ?
    QR_FIXTURE_REFUSAL_MESSAGE : undefined;
}

export function isQrFixtureOutcome(value: string): value is QrFixtureOutcome {
  return value === 'input-method-invalid' || value === 'network-bad-response-406' || value === 'token';
}

export function parseQrFixtureOutcome(value: string | null): QrFixtureOutcome | undefined {
  if(value === null) return 'token';
  return isQrFixtureOutcome(value) ? value : undefined;
}

export function parseQrFixtureSearchParams(params: URLSearchParams): QrFixtureOutcome | undefined {
  if([...params.keys()].some((key) => key !== 'outcome') || params.getAll('outcome').length > 1) {
    return undefined;
  }

  return parseQrFixtureOutcome(params.get('outcome'));
}
