import {afterEach, describe, expect, it, vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {
  ACTIVE_SERVER_ID_KEY,
  SERVER_CHOICE_KEY,
  SERVER_PINS_KEY,
  forgetServer
} from '@config/serverSelection';

vi.stubGlobal('crypto', webcrypto);

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('forget server pin', () => {
  it('keeps the pin and active selection when namespace deletion is blocked', async() => {
    const host = 'chat.example.org';
    const id = 'custom-' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(host)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const pin = {host, endpoint: 'wss://chat.example.org/apiws', dc_id: 2, key_fingerprint: 'a'.repeat(64)};
    localStorage.setItem(SERVER_PINS_KEY, JSON.stringify({[host]: pin}));
    localStorage.setItem(SERVER_CHOICE_KEY, host);
    localStorage.setItem(ACTIVE_SERVER_ID_KEY, id);

    vi.stubGlobal('indexedDB', {
      databases: async(): Promise<IDBDatabaseInfo[]> => [],
      deleteDatabase: () => {
        const request: any = {};
        queueMicrotask(() => request.onblocked?.());
        return request;
      }
    });

    await expect(forgetServer(host)).rejects.toThrow('Close other tabs using this server before forgetting it');
    expect(JSON.parse(localStorage.getItem(SERVER_PINS_KEY) || '{}')[host]).toEqual(pin);
    expect(localStorage.getItem(SERVER_CHOICE_KEY)).toBe(host);
    expect(localStorage.getItem(ACTIVE_SERVER_ID_KEY)).toBe(id);
  });
});
