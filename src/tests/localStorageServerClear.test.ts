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

  it('invalidates a cached key in another storage instance when its browser storage event arrives', async() => {
    type GuestStorage = {guestCredentials?: {username: string, password: string}[]};
    const firstTabStorage = new LocalStorageController<GuestStorage>();
    const secondTabStorage = new LocalStorageController<GuestStorage>();
    const savedCredentials = [{username: 'guest_saved', password: 'secret'}];

    await firstTabStorage.set({guestCredentials: savedCredentials});
    await secondTabStorage.get('guestCredentials', false);
    const storageKey = Array.from({length: localStorage.length}, (_, index) => localStorage.key(index))
    .find((key) => key?.endsWith('guestCredentials'));
    expect(storageKey).toBeTruthy();

    expect(await firstTabStorage.get('guestCredentials')).toEqual(savedCredentials);
    await secondTabStorage.delete('guestCredentials');
    expect(await firstTabStorage.get('guestCredentials')).toEqual(savedCredentials);
    expect(await firstTabStorage.get('guestCredentials', false)).toBeUndefined();

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'guest-credential-lifecycle-clear.v1',
      oldValue: null,
      newValue: 'invalidation',
      storageArea: localStorage
    }));

    expect(await firstTabStorage.get('guestCredentials')).toBeUndefined();
  });
});
