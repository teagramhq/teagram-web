import {afterEach, describe, expect, it, vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {
  ACTIVE_SERVER_ID_KEY,
  SERVER_CHOICE_KEY,
  SERVER_PINS_KEY,
  SERVER_TARGET_KEY,
  forgetServer
} from '@config/serverSelection';

vi.stubGlobal('crypto', webcrypto);

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('forget server pin', () => {
  it('clears the effective default profile without deleting other server data', async() => {
    const host = 'web.teagram.io';
    const otherServerId = 'custom-' + 'b'.repeat(64);
    const pins = {
      [host]: {host, endpoint: 'wss://server.teagram.io/apiws', dc_id: 2, key_fingerprint: 'a'.repeat(64)},
      'other.example.org': {host: 'other.example.org', endpoint: 'wss://other.example.org/apiws', dc_id: 2, key_fingerprint: 'b'.repeat(64)}
    };
    localStorage.setItem(SERVER_PINS_KEY, JSON.stringify(pins));
    localStorage.setItem(SERVER_CHOICE_KEY, host);
    localStorage.setItem(ACTIVE_SERVER_ID_KEY, 'default');
    localStorage.setItem(SERVER_TARGET_KEY, JSON.stringify({host}));
    localStorage.setItem('account1', 'old-default-account');
    localStorage.setItem('auth-key-recovery:1:2', 'old-default-auth-key');
    localStorage.setItem(`teagram-${otherServerId}:account1`, 'other-server-account');
    localStorage.setItem('teagram.global-setting', 'keep');

    const databaseNames = [
      'tweb', 'tweb-common', 'tweb-account-1', 'tweb-account-2', 'tweb-account-3', 'tweb-account-4', 'telegram',
      `tweb-${otherServerId}`, `tweb-${otherServerId}-common`, `telegram-${otherServerId}`
    ];
    const deletedDatabases: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {request: vi.fn(async(_name: string, callback: () => void) => callback())}
    });
    vi.stubGlobal('indexedDB', {
      databases: async(): Promise<IDBDatabaseInfo[]> => databaseNames.map((name) => ({name})),
      deleteDatabase: (name: string) => {
        deletedDatabases.push(name);
        const request: any = {};
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    });
    const deletedCaches: string[] = [];
    vi.stubGlobal('caches', {
      keys: async() => ['cachedAssets', `teagram-${otherServerId}-cachedAssets`],
      delete: async(name: string) => { deletedCaches.push(name); return true; }
    });

    await forgetServer(host, 'default');

    expect(localStorage.getItem('account1')).toBeNull();
    expect(localStorage.getItem('auth-key-recovery:1:2')).toBeNull();
    expect(localStorage.getItem(`teagram-${otherServerId}:account1`)).toBe('other-server-account');
    expect(localStorage.getItem('teagram.global-setting')).toBe('keep');
    expect(localStorage.getItem(SERVER_CHOICE_KEY)).toBeNull();
    expect(localStorage.getItem(ACTIVE_SERVER_ID_KEY)).toBeNull();
    expect(localStorage.getItem(SERVER_TARGET_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(SERVER_PINS_KEY) || '{}')).toEqual({
      'other.example.org': pins['other.example.org']
    });
    expect(deletedDatabases).toEqual(expect.arrayContaining([
      'tweb', 'tweb-common', 'tweb-account-1', 'tweb-account-2', 'tweb-account-3', 'tweb-account-4', 'telegram'
    ]));
    expect(deletedDatabases).not.toContain(`tweb-${otherServerId}`);
    expect(deletedCaches).toEqual(['cachedAssets']);
  });

  it('keeps the pin and active selection when namespace deletion is blocked', async() => {
    const host = 'chat.example.org';
    const id = 'custom-' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(host)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const pin = {host, endpoint: 'wss://chat.example.org/apiws', dc_id: 2, key_fingerprint: 'a'.repeat(64)};
    localStorage.setItem(SERVER_PINS_KEY, JSON.stringify({[host]: pin}));
    localStorage.setItem(SERVER_CHOICE_KEY, host);
    localStorage.setItem(ACTIVE_SERVER_ID_KEY, id);
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(async(_name: string, callback: () => void) => callback())
      }
    });

    vi.stubGlobal('indexedDB', {
      databases: async(): Promise<IDBDatabaseInfo[]> => [],
      deleteDatabase: () => {
        const request: any = {};
        queueMicrotask(() => request.onblocked?.());
        return request;
      }
    });

    await expect(forgetServer(host, id)).rejects.toThrow('Close other tabs using this server before forgetting it');
    expect(JSON.parse(localStorage.getItem(SERVER_PINS_KEY) || '{}')[host]).toEqual(pin);
    expect(localStorage.getItem(SERVER_CHOICE_KEY)).toBe(host);
    expect(localStorage.getItem(ACTIVE_SERVER_ID_KEY)).toBe(id);
  });
});
