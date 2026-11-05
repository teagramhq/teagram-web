import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const idbDatabase = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  getFailure: undefined as Error | undefined,
  saveFailure: undefined as Error | undefined,
  clearFailure: undefined as Error | undefined
}));

vi.mock('@lib/apiManagerProxy', () => ({
  default: {
    invoke: async(_event: string, payload: {name: string, method: string, args: any[]}) => {
      const manager = (await import('@lib/mainWorker/telegramStickerPackTokenStorageManager')).default as any;
      return manager[payload.method](...payload.args);
    }
  }
}));

vi.mock('@lib/files/idb', () => ({
  default: class {
    private store: Map<string, unknown>;

    constructor(db: {name: string}, storeName: string) {
      const key = `${db.name}:${storeName}`;
      this.store = idbDatabase.stores.get(key) || new Map<string, unknown>();
      idbDatabase.stores.set(key, this.store);
    }

    async get<T>(keys: string | string[], _storeName?: string, suppressValueLogging = false): Promise<T | T[]> {
      if(idbDatabase.getFailure) throw idbDatabase.getFailure;
      const values = Array.isArray(keys) ? keys.map((key) => this.store.get(key)) as T[] : this.store.get(keys) as T;
      void suppressValueLogging;
      return values;
    }

    async save(keys: string | string[], values: unknown | unknown[]) {
      if(idbDatabase.saveFailure) throw idbDatabase.saveFailure;
      const names = Array.isArray(keys) ? keys : [keys];
      const entries = Array.isArray(values) ? values : [values];
      names.forEach((key, index) => {
        const value = entries[index];
        this.store.set(key, ArrayBuffer.isView(value) ? new Uint8Array(Array.from(value as Uint8Array)) : value);
      });
    }

    async delete(keys: string | string[]) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => this.store.delete(key));
    }

    async clear() {
      if(idbDatabase.clearFailure) throw idbDatabase.clearFailure;
      this.store.clear();
    }

    async getAllEntries() {
      return Array.from(this.store.entries());
    }

    async getAll() {
      return Array.from(this.store.values());
    }

    async getAllKeys() {
      return Array.from(this.store.keys());
    }
  }
}));

import type {AccountDatabase} from '@config/databases/state';
import {getDatabaseState} from '@config/databases/state';
import {getSavedTelegramBotToken, removeTelegramBotToken, saveTelegramBotToken} from '@helpers/telegramStickerPackTokenStorage';
import {AppStoragesManager} from '@appManagers/appStoragesManager';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import EncryptedStorageLayer from '@lib/encryptedStorageLayer';
import IDBStorage from '@lib/files/idb';
import AppStorage from '@lib/storage';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import EncryptionKeyStore from '@lib/passcode/keyStore';

vi.mock('@lib/crypto/cryptoMessagePort', () => ({
  default: {invokeCryptoNew: async({args}: any) => {
    const input = args[0].data || args[0].encryptedData;
    return Uint8Array.from(new Uint8Array(input), (byte) => byte ^ 0xa5);
  }}
}));

const accountNumber: ActiveAccountNumber = 4;
const savedToken = `987654321:${'B'.repeat(35)}`;
type TokenSession = Record<string, unknown> & {telegramBotToken?: string};

function localStorageValues() {
  return Array.from({length: localStorage.length}, (_, index) =>
    localStorage.getItem(localStorage.key(index) || '') || ''
  ).join('\n');
}

async function preparePasscodeStorage() {
  DeferredIsUsingPasscode.resolveDeferred(true);
  EncryptionKeyStore.save({} as CryptoKey);
  await AppStorage.toggleEncryptedForAll(true);
}

async function readAfterStorageReload() {
  (EncryptedStorageLayer as any).instances.clear();
  const storage = new AppStorage<TokenSession, AccountDatabase>(getDatabaseState(accountNumber), 'session', ['telegramBotToken']);
  return storage.get('telegramBotToken', false);
}

async function clearMockDatabases() {
  for(const store of idbDatabase.stores.values()) store.clear();
}

function containsBytes(value: Uint8Array, search: Uint8Array) {
  return value.some((_, start) => search.every((byte, index) => value[start + index] === byte));
}

beforeEach(async() => {
  DeferredIsUsingPasscode.resolveDeferred(false);
  EncryptionKeyStore.save(undefined);
  await AppStorage.toggleEncryptedForAll(false);
  await clearMockDatabases();
  idbDatabase.getFailure = undefined;
  idbDatabase.saveFailure = undefined;
  idbDatabase.clearFailure = undefined;
  try {
    await removeTelegramBotToken(accountNumber);
  } catch{}
});

afterEach(async() => {
  vi.restoreAllMocks();
  idbDatabase.getFailure = undefined;
  idbDatabase.saveFailure = undefined;
  idbDatabase.clearFailure = undefined;
  DeferredIsUsingPasscode.resolveDeferred(false);
  EncryptionKeyStore.save(undefined);
  await AppStorage.toggleEncryptedForAll(false);
  try {
    await removeTelegramBotToken(accountNumber);
  } catch{}
  await new IDBStorage(getDatabaseState(accountNumber), 'session').delete('telegramBotToken');
  await clearMockDatabases();
});

describe('Telegram bot token storage', () => {
  it('stores successful imports in the account session database without localStorage when no passcode is set', async() => {
    await saveTelegramBotToken(accountNumber, savedToken);

    const accountSession = new IDBStorage(getDatabaseState(accountNumber), 'session');
    expect(localStorageValues()).not.toContain(savedToken);
    expect(await accountSession.get('telegramBotToken')).toBe(savedToken);
    expect(await getSavedTelegramBotToken(accountNumber)).toBe(savedToken);
  });

  it('keeps tokens out of localStorage when a passcode is enabled after the import flow opens', async() => {
    expect(await getSavedTelegramBotToken(accountNumber)).toBeUndefined();
    await preparePasscodeStorage();
    await saveTelegramBotToken(accountNumber, savedToken);

    const accountSession = new IDBStorage(getDatabaseState(accountNumber), 'session');
    const encryptedSession = new IDBStorage(getDatabaseState(accountNumber), 'session__encrypted' as any);
    const encryptedData = await encryptedSession.get('data');
    expect(encryptedData).toBeInstanceOf(Uint8Array);
    expect(containsBytes(encryptedData as Uint8Array, new TextEncoder().encode(savedToken))).toBe(false);
    expect(localStorageValues()).not.toContain(savedToken);
    expect(await accountSession.get('telegramBotToken')).toBeUndefined();
    expect(await encryptedSession.getAllEntries()).toHaveLength(1);
    expect(await getSavedTelegramBotToken(accountNumber)).toBe(savedToken);
  });

  it('moves saved tokens with account session data when account slots shift', async() => {
    await saveTelegramBotToken(accountNumber, savedToken);

    await AppStoragesManager.shiftStorages(3);

    expect(await getSavedTelegramBotToken(3)).toBe(savedToken);
    expect(await getSavedTelegramBotToken(accountNumber)).toBeUndefined();
  });

  it('removes a plaintext token from session, localStorage, and encrypted storage', async() => {
    await saveTelegramBotToken(accountNumber, savedToken);

    await removeTelegramBotToken(accountNumber);

    const persistedStores = JSON.stringify(Array.from(idbDatabase.stores, ([name, store]) => [name, Array.from(store.entries())]));
    const encryptedSession = new IDBStorage(getDatabaseState(accountNumber), 'session__encrypted' as any);
    expect(await readAfterStorageReload()).toBeUndefined();
    expect(persistedStores).not.toContain(savedToken);
    expect(localStorageValues()).not.toContain(savedToken);
    expect(await encryptedSession.get('data')).toBeUndefined();
  });

  it('clears the saved token during account logout cleanup', async() => {
    await saveTelegramBotToken(accountNumber, savedToken);

    await AppStoragesManager.clearAllStoresForAccount(accountNumber);

    expect(await getSavedTelegramBotToken(accountNumber)).toBeUndefined();
  });

  it('surfaces account cleanup failures instead of reporting logout storage cleared', async() => {
    await saveTelegramBotToken(accountNumber, savedToken);
    idbDatabase.clearFailure = new Error('session storage clear failed');

    await expect(AppStoragesManager.clearAllStoresForAccount(accountNumber)).rejects.toThrow('session storage clear failed');
    idbDatabase.clearFailure = undefined;
    expect(await getSavedTelegramBotToken(accountNumber)).toBe(savedToken);
  });

  it('logs sensitive read failures with their cause and key but no value', async() => {
    const storage = new AppStorage<TokenSession, AccountDatabase>(getDatabaseState(accountNumber), 'session', ['telegramBotToken']);
    const errorLog = vi.fn();
    (storage as any).log = {error: errorLog};
    const failure = new Error('read failed');
    idbDatabase.getFailure = failure;

    await expect(storage.get('telegramBotToken', false)).rejects.toBe(failure);

    expect(errorLog).toHaveBeenCalledWith('get error for sensitive storage values', failure, ['telegramBotToken'], 'session');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(savedToken);
  });

  it('logs sensitive write failures with their cause and key but no value', async() => {
    const storage = new AppStorage<TokenSession, AccountDatabase>(getDatabaseState(accountNumber), 'session', ['telegramBotToken']);
    const errorLog = vi.fn();
    (storage as any).log = {error: errorLog};
    const failure = new Error('write failed');
    idbDatabase.saveFailure = failure;

    await expect(storage.set({telegramBotToken: savedToken})).rejects.toBe(failure);

    expect(errorLog).toHaveBeenCalledWith('set error for sensitive storage values', failure, ['telegramBotToken']);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(savedToken);
  });

  it('waits for encrypted deletion to flush before reporting removal and survives a fresh storage read', async() => {
    await saveTelegramBotToken(accountNumber, savedToken);
    await preparePasscodeStorage();

    let startedFlush!: () => void;
    const flushStarted = new Promise<void>((resolve) => { startedFlush = resolve; });
    let finishFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { finishFlush = resolve; });
    const flush = EncryptedStorageLayer.prototype.flush;
    vi.spyOn(EncryptedStorageLayer.prototype, 'flush').mockImplementation(async function(this: EncryptedStorageLayer<any>) {
      startedFlush();
      await flushGate;
      await flush.call(this);
    });

    let removalSettled = false;
    const removal = removeTelegramBotToken(accountNumber).then(() => { removalSettled = true; });
    await flushStarted;
    expect(removalSettled).toBe(false);
    finishFlush();
    await removal;

    expect(await readAfterStorageReload()).toBeUndefined();
  });

  it('propagates encrypted flush failures and leaves the token available after reload', async() => {
    await saveTelegramBotToken(accountNumber, savedToken);
    await preparePasscodeStorage();

    vi.spyOn(EncryptedStorageLayer.prototype, 'flush').mockRejectedValue(new Error('encrypted session storage flush failed'));

    await expect(removeTelegramBotToken(accountNumber)).rejects.toThrow('encrypted session storage flush failed');
    vi.restoreAllMocks();

    expect(await readAfterStorageReload()).toBe(savedToken);
  });

  it('propagates encrypted delete failures and preserves the token after reload', async() => {
    await saveTelegramBotToken(accountNumber, savedToken);
    await preparePasscodeStorage();
    vi.spyOn(EncryptedStorageLayer.prototype, 'delete').mockRejectedValue(new Error('encrypted session storage delete failed'));

    await expect(removeTelegramBotToken(accountNumber)).rejects.toThrow('encrypted session storage delete failed');
    vi.restoreAllMocks();

    expect(await readAfterStorageReload()).toBe(savedToken);
  });
});
