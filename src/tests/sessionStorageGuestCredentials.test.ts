import {describe, expect, it} from 'vitest';
import sessionStorage from '@lib/sessionStorage';

describe('guest credential storage', () => {
  it('uses passcode-aware encrypted storage', () => {
    expect((sessionStorage as any).encryptableKeys.has('guestCredentials')).toBe(true);
  });
});
