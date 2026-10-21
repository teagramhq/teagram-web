import {beforeEach, describe, expect, it, vi} from 'vitest';

const encryptedStore = vi.hoisted(() => ({
  values: new Map<string, Uint8Array>(),
  writeGate: undefined as Promise<void> | undefined,
  writeStarted: 0
}));

vi.mock('@lib/files/idb', () => ({
  default: class {
    private key: string;

    constructor(db: {name: string}, storeName: string) {
      this.key = `${db.name}:${storeName}:data`;
    }

    async get() {
      const value = encryptedStore.values.get(this.key);
      return value && new Uint8Array(value);
    }

    async save(_entryName: string, value: Uint8Array) {
      encryptedStore.writeStarted++;
      if(encryptedStore.writeGate) await encryptedStore.writeGate;
      encryptedStore.values.set(this.key, new Uint8Array(value));
    }

    async delete() {
      encryptedStore.values.delete(this.key);
    }

    async clear() {
      encryptedStore.values.clear();
    }
  }
}));

vi.mock('@lib/crypto/cryptoMessagePort', () => ({
  default: {invokeCryptoNew: async({args}: any) => args[0].data || args[0].encryptedData}
}));

vi.mock('@lib/passcode/keyStore', () => ({default: {get: async(): Promise<undefined> => undefined}}));
vi.mock('@lib/passcode/deferredIsUsingPasscode', () => ({default: {isUsingPasscode: async() => true}}));

import type EncryptedStorageLayer from '@lib/encryptedStorageLayer';
import EncryptedStorageLayerClass from '@lib/encryptedStorageLayer';
import LocalStorageController from '@lib/localStorage';

type GuestStorage = {guestCredentials?: {username: string, password: string}[]};

class PasscodeStorage extends LocalStorageController<GuestStorage> {
  constructor(private encrypted: EncryptedStorageLayer<any>) {
    super(['guestCredentials']);
    this.encrypted.loadEncrypted();
  }

  public async encryptedStorageProxy(type: string, ...args: any[]) {
    return (this.encrypted as any)[type](...args);
  }
}

let databaseId = 0;

function createPasscodeStorage(name = `guest-credential-cache-test-${++databaseId}`) {
  const db = {name, stores: []} as any;
  const Layer = EncryptedStorageLayerClass as any;
  const encrypted = new Layer(db, 'encrypted') as EncryptedStorageLayer<any>;
  return {db, encrypted, storage: new PasscodeStorage(encrypted)};
}

function putEncryptedData(db: {name: string}, data: Record<string, unknown>) {
  encryptedStore.values.set(
    `${db.name}:encrypted:data`,
    new TextEncoder().encode(JSON.stringify(data))
  );
}

function dispatchGuestCredentialInvalidation() {
  const event = new Event('storage');
  Object.defineProperty(event, 'key', {value: 'guest-credential-lifecycle-clear.v1'});
  window.dispatchEvent(event);
}

beforeEach(() => {
  encryptedStore.values.clear();
  encryptedStore.writeGate = undefined;
  encryptedStore.writeStarted = 0;
  delete (globalThis as any).__TEAGRAM_ACTIVE_SERVER_ID__;
});

describe('passcode guest credential persistence', () => {
  it('bypasses an encrypted tab cache for an authoritative guest read', async() => {
    const saved = [{username: 'guest_saved', password: 'secret'}];
    const dbName = `guest-credential-cache-test-${++databaseId}`;
    putEncryptedData({name: dbName}, {guestCredentials: saved});
    const tab = createPasscodeStorage(dbName);

    expect(await tab.storage.get('guestCredentials')).toEqual(saved);
    putEncryptedData(tab.db, {});

    await expect(tab.storage.get('guestCredentials', false)).resolves.toBeUndefined();
  });

  it('persists unrelated pending writes during an authoritative guest read', async() => {
    const dbName = `guest-credential-cache-test-${++databaseId}`;
    putEncryptedData({name: dbName}, {
      guestCredentials: [{username: 'guest_saved', password: 'secret'}],
      account2: {state_id: 1}
    });
    const tab = createPasscodeStorage(dbName);
    await tab.encrypted.get(['guestCredentials']);

    vi.useFakeTimers();
    try {
      await tab.encrypted.save('account2', {state_id: 2});
      await tab.encrypted.get(['guestCredentials'], false);

      const reopenedTab = createPasscodeStorage(dbName);
      await expect(reopenedTab.encrypted.get(['account2'])).resolves.toEqual([{state_id: 2}]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists a pending write to the requested key during an authoritative read', async() => {
    const dbName = `guest-credential-cache-test-${++databaseId}`;
    putEncryptedData({name: dbName}, {guestCredentials: [{username: 'guest_saved', password: 'secret'}]});
    const tab = createPasscodeStorage(dbName);
    await tab.encrypted.get(['guestCredentials']);

    vi.useFakeTimers();
    try {
      const updated = [{username: 'guest_updated', password: 'new-secret'}];
      await tab.storage.set({guestCredentials: updated});
      await expect(tab.storage.get('guestCredentials', false)).resolves.toEqual(updated);

      const reopenedTab = createPasscodeStorage(dbName);
      await expect(reopenedTab.storage.get('guestCredentials')).resolves.toEqual(updated);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes independent tab caches after another tab forgets a guest', async() => {
    const saved = [{username: 'guest_saved', password: 'secret'}];
    const dbName = `guest-credential-cache-test-${++databaseId}`;
    putEncryptedData({name: dbName}, {guestCredentials: saved});
    const firstTab = createPasscodeStorage(dbName);
    const secondTab = createPasscodeStorage(dbName);

    expect(await firstTab.storage.get('guestCredentials')).toEqual(saved);
    expect(await secondTab.storage.get('guestCredentials')).toEqual(saved);

    putEncryptedData(firstTab.db, {});
    dispatchGuestCredentialInvalidation();

    await vi.waitFor(async() => {
      expect(await firstTab.storage.get('guestCredentials')).toBeUndefined();
      expect(await secondTab.storage.get('guestCredentials')).toBeUndefined();
    });
  });

  it('waits for the encrypted IndexedDB write when flushing guest credentials', async() => {
    let releaseWrite!: () => void;
    encryptedStore.writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const tab = createPasscodeStorage();

    await tab.storage.set({guestCredentials: [{username: 'guest_saved', password: 'secret'}]});
    await vi.waitFor(() => expect(encryptedStore.writeStarted).toBeGreaterThan(0));

    let flushed = false;
    const flushPromise = tab.storage.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);

    releaseWrite();
    await flushPromise;
    expect(encryptedStore.values.has(`${tab.db.name}:encrypted:data`)).toBe(true);

    await tab.storage.delete('guestCredentials');
    await tab.storage.flush();
    expect(encryptedStore.values.has(`${tab.db.name}:encrypted:data`)).toBe(false);
  });
});
