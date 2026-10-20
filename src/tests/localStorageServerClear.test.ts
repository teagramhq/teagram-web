import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@config/modes', () => ({default: {test: false}}));

import LocalStorageController from '@lib/localStorage';

beforeEach(() => {
  localStorage.clear();
  delete (globalThis as any).__TEAGRAM_ACTIVE_SERVER_ID__;
});

describe('default server localStorage cleanup', () => {
  it('preserves custom server account, auth, and passcode values', async() => {
    const customServerPrefix = `teagram-custom-${'a'.repeat(64)}:`;
    localStorage.setItem(customServerPrefix + 'dc2_auth_key', JSON.stringify('custom-auth-key'));
    localStorage.setItem(customServerPrefix + 'account1', JSON.stringify({id: 'custom-account'}));
    localStorage.setItem(customServerPrefix + 'passcode', JSON.stringify('custom-passcode'));
    localStorage.setItem('dc2_auth_key', JSON.stringify('default-auth-key'));

    const storage = new LocalStorageController<Record<string, unknown>>();
    await storage.localStorageProxy('clear');

    expect(localStorage.getItem(customServerPrefix + 'dc2_auth_key')).toBe(JSON.stringify('custom-auth-key'));
    expect(localStorage.getItem(customServerPrefix + 'account1')).toBe(JSON.stringify({id: 'custom-account'}));
    expect(localStorage.getItem(customServerPrefix + 'passcode')).toBe(JSON.stringify('custom-passcode'));
    expect(localStorage.getItem('dc2_auth_key')).toBeNull();
  });
});
