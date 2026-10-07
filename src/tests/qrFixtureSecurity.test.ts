import {
  getQrFixtureMountRefusal,
  isQrFixtureOutcome,
  parseQrFixtureOutcome,
  parseQrFixtureSearchParams
} from '@/qrFixtureSecurity';

const REFUSAL = 'Synthetic QR fixture refused to mount';
const FORBIDDEN_AUTH_KEYS = [
  'account1',
  'account4',
  'dc1_auth_key',
  'dc5_server_salt',
  'user_auth',
  'preview_auth_seeded'
];

describe('QR fixture mount guard', () => {
  it('allows a fresh non-preview browser context', () => {
    expect(getQrFixtureMountRefusal(false, [], [])).toBeUndefined();
  });

  it('refuses preview mode with a fixed message', () => {
    expect(getQrFixtureMountRefusal(true, [], [])).toBe(REFUSAL);
  });

  it.each(FORBIDDEN_AUTH_KEYS)('refuses the %s key in either browser storage', (key) => {
    expect(getQrFixtureMountRefusal(false, [key], [])).toBe(REFUSAL);
    expect(getQrFixtureMountRefusal(false, [], [key])).toBe(REFUSAL);
  });

  it('fails closed when browser storage cannot be inspected', () => {
    expect(getQrFixtureMountRefusal(false, undefined, [])).toBe(REFUSAL);
    expect(getQrFixtureMountRefusal(false, [], undefined)).toBe(REFUSAL);
  });

  it('accepts only the three fixed export outcomes', () => {
    expect(parseQrFixtureOutcome(null)).toBe('token');
    expect(parseQrFixtureOutcome('input-method-invalid')).toBe('input-method-invalid');
    expect(parseQrFixtureOutcome('network-bad-response-406')).toBe('network-bad-response-406');
    expect(parseQrFixtureOutcome('token')).toBe('token');
    expect(isQrFixtureOutcome('input-method-invalid')).toBe(true);
    expect(isQrFixtureOutcome('network-bad-response-406')).toBe(true);
    expect(isQrFixtureOutcome('token')).toBe(true);
    expect(parseQrFixtureOutcome('https://example.invalid/')).toBeUndefined();
    expect(isQrFixtureOutcome('raw error text')).toBe(false);
  });

  it('rejects account and other unrecognized query inputs', () => {
    expect(parseQrFixtureSearchParams(new URLSearchParams('outcome=token'))).toBe('token');
    expect(parseQrFixtureSearchParams(new URLSearchParams('outcome=token&account=1'))).toBeUndefined();
    expect(parseQrFixtureSearchParams(new URLSearchParams('outcome=token&outcome=token'))).toBeUndefined();
  });

  it('allows only the fixed suggested-language fixture toggle', () => {
    expect(parseQrFixtureSearchParams(new URLSearchParams('outcome=input-method-invalid&suggested-language=1')))
    .toBe('input-method-invalid');
    expect(parseQrFixtureSearchParams(new URLSearchParams('outcome=input-method-invalid&suggested-language=0')))
    .toBeUndefined();
    expect(parseQrFixtureSearchParams(new URLSearchParams('outcome=input-method-invalid&suggested-language=1&suggested-language=1')))
    .toBeUndefined();
  });
});
