import {Database} from '@config/databases';
import DEBUG from '@config/debug';
import toArray from '@helpers/array/toArray';
import convertToUint8Array from '@helpers/bytes/convertToUint8Array';
import {IS_WORKER} from '@helpers/context';
import formatBytesPure from '@helpers/formatBytesPure';
import asyncThrottle from '@helpers/schedulers/asyncThrottle';

import cryptoMessagePort from '@lib/crypto/cryptoMessagePort';
import IDBStorage from '@lib/files/idb';
import {logger, Logger} from '@lib/logger';
import MTProtoMessagePort from '@lib/mainWorker/mainMessagePort';
import EncryptionKeyStore from '@lib/passcode/keyStore';


export interface StorageLayer {
  save: (entryName: string | string[], value: any | any[]) => Promise<unknown>;
  get: <T>(entryNames: string[]) => Promise<T[]>;
  getAllEntries: () => Promise<IDBStorage.Entries>;
  getAll: <T>() => Promise<T[]>;
  getAllKeys: () => Promise<IDBValidKey[]>;
  delete: (entryName: string | string[]) => Promise<void>;
  clear: () => Promise<void>;
};

type StoredData = Record<string, any>;

export default class EncryptedStorageLayer<T extends Database<any>> implements StorageLayer
{
  private static STORAGE_KEY = 'data';
  // private static STORAGE_THROTTLE_TIME_MS = 250;
  /**
   * Having a delay here can break the app after logout, due to the fact that some updates might be queued in here before the
   * storages were disabled, and after the timeout it will save the data anyway (that might have been cleared for logout)
   */
  private static STORAGE_THROTTLE_TIME_MS = 0;

  private static instances = new Map<string, EncryptedStorageLayer<Database<any>>>();

  private storage: IDBStorage<T>;
  private data: StoredData;
  private dirtyEntries = new Map<string, number>();
  private dirtyEntryVersion = 0;

  private log: Logger;

  private loadingDataPromise: Promise<unknown>;
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor(private db: T, private encryptedStoreName: T['stores'][number]['encryptedName']) {
    this.storage = new IDBStorage(db, encryptedStoreName);
    this.log = logger(`encrypted-storage-${encryptedStoreName}`)
  }

  public static getInstance<T extends Database<any>>(db: T, encryptedStoreName: T['stores'][number]['encryptedName']): EncryptedStorageLayer<T> {
    const key = this.getStorageKey(db.name, encryptedStoreName);
    if(this.instances.has(key)) return this.instances.get(key) as EncryptedStorageLayer<T>;

    const instance = new EncryptedStorageLayer(db, encryptedStoreName);
    this.instances.set(key, instance);
    return instance;
  }

  private static getStorageKey(dbName: string, storeName: string) {
    return `${dbName}**${storeName}`;
  }

  private static async encrypt(data: StoredData): Promise<Uint8Array | null> {
    if(!Object.keys(data).length) return null;

    const key = await EncryptionKeyStore.get();
    const dataAsBuffer = convertToUint8Array(JSON.stringify(data));

    const result = await cryptoMessagePort.invokeCryptoNew({
      method: 'aes-local-encrypt',
      args: [{
        key,
        data: dataAsBuffer
      }],
      transfer: [dataAsBuffer.buffer]
    });

    return result;
  }

  private static async decrypt(data: Uint8Array): Promise<StoredData> {
    const key = await EncryptionKeyStore.get();

    const result = await cryptoMessagePort.invokeCryptoNew({
      method: 'aes-local-decrypt',
      args: [{
        key,
        encryptedData: data
      }],
      transfer: [data.buffer]
    });

    const decoded = new TextDecoder().decode(result);
    return JSON.parse(decoded);
  }

  public loadEncrypted() {
    (async() => {
      this.loadingDataPromise = this.loadFromIDB();
      await this.loadingDataPromise;
      this.loadingDataPromise = undefined;
    })();
  }

  public async loadDecrypted(data: StoredData) {
    this.log('loading decrypted', data);
    this.data = data;
    await this.flush();
  }

  private waitToLoad() {
    if(this.loadingDataPromise) return this.loadingDataPromise;
  }

  private saveToIDB = async() => {
    await this.waitToLoad();

    const data = {...this.data};
    const dirtyEntries = new Map(this.dirtyEntries);

    const startTime = performance.now();


    const encryptedData = await EncryptedStorageLayer.encrypt(data);
    const encryptedDataSize = encryptedData?.length || 0;

    const encryptionTime = performance.now();

    if(encryptedData) {
      await this.storage.save(EncryptedStorageLayer.STORAGE_KEY, encryptedData);
    } else {
      await this.storage.delete(EncryptedStorageLayer.STORAGE_KEY);
    }

    dirtyEntries.forEach((version, entryName) => {
      if(this.dirtyEntries.get(entryName) === version) this.dirtyEntries.delete(entryName);
    });


    const endTime = performance.now();

    if(DEBUG && IS_WORKER) {
      /**
       * The time it takes is very random, it might be because of the busy-ness of the crypto worker and the indexed DB
       *
       * Can be a log for 5.5 KB in 8ms, and then another for 40 KB in just 3ms
       * Or a whole MegaByte in just 20ms which is not proportional at all
       */
      const f = (n: number) => n.toFixed(2);
      const port = MTProtoMessagePort.getInstance<false>();
      port.invokeVoid('log', `[${this.db.name}-${this.encryptedStoreName}] Encrypted and saved ` +
        `${encryptedDataSize} bytes (${formatBytesPure(encryptedDataSize, 2)}) of data in ${f(endTime - startTime)}ms ` +
        `-- (encrypted in ${f(encryptionTime - startTime)}ms, saved in ${f(endTime - encryptionTime)}ms)`)
    }
  };

  private queueSaveToIDB = async() => {
    const save = this.saveQueue.then(() => this.saveToIDB());
    this.saveQueue = save.catch((): void => undefined);
    await save;
  };

  private saveToIDBThrottled = asyncThrottle(
    () => this.queueSaveToIDB(),
    EncryptedStorageLayer.STORAGE_THROTTLE_TIME_MS
  );

  private async readFromIDB() {
    const storageData = await this.storage.get(EncryptedStorageLayer.STORAGE_KEY);
    if(storageData === null || storageData === undefined) return {};
    if(!(storageData instanceof Uint8Array)) throw new Error('Stored data in encrypted store is not a Uint8Array');
    return EncryptedStorageLayer.decrypt(storageData);
  }

  private async loadFromIDB() {
    try {
      this.data = await this.readFromIDB();
    } catch(error) {
      if(error) this.log(error);
      this.data = {};
    }

    return this.data;
  }

  private async refreshFromIDB() {
    (this.saveToIDBThrottled as any).clear();
    await this.saveQueue;
    const storedData = await this.readFromIDB();
    const dirtyEntries = new Map(this.dirtyEntries);
    const dirtyValues = new Map<string, {exists: boolean, value: unknown}>();

    dirtyEntries.forEach((_version, entryName) => {
      dirtyValues.set(entryName, {
        exists: Object.prototype.hasOwnProperty.call(this.data, entryName),
        value: this.data[entryName]
      });
    });

    this.data = storedData;
    dirtyValues.forEach(({exists, value}, entryName) => {
      if(exists) this.data[entryName] = value;
      else delete this.data[entryName];
    });

    if(this.dirtyEntries.size) await this.flush();
  }

  public async reEncrypt() {
    await this.flush();
  }

  public async flush() {
    (this.saveToIDBThrottled as any).clear();
    await this.queueSaveToIDB();
  }

  public async save(entryName: string | string[], value: any | any[]): Promise<void> {
    await this.waitToLoad();

    const names = toArray(entryName);
    const values = toArray(value);

    names.forEach((name, idx) => {
      this.data[name] = values[idx];
      this.dirtyEntries.set(name, ++this.dirtyEntryVersion);
    });

    this.saveToIDBThrottled();
  }

  public async get<T>(entryNames: string[], useCache = true): Promise<T[]> {
    await this.waitToLoad();
    if(!useCache) await this.refreshFromIDB();

    return entryNames.map((entryName) => this.data[entryName]);
  }

  public async getAllEntries(): Promise<IDBStorage.Entries> {
    await this.waitToLoad();

    return Object.entries(this.data);
  }

  public async getAll<T>(): Promise<T[]> {
    await this.waitToLoad();

    return Object.values(this.data);
  }

  public async getAllKeys(): Promise<IDBValidKey[]> {
    await this.waitToLoad();

    return Object.keys(this.data);
  }

  public async delete(entryName: string | string[]): Promise<void> {
    await this.waitToLoad();

    const names = toArray(entryName);
    names.forEach(name => {
      delete this.data[name];
      this.dirtyEntries.set(name, ++this.dirtyEntryVersion);
    });

    this.saveToIDBThrottled();
  }

  public async clear(): Promise<void> {
    (this.saveToIDBThrottled as any).clear();
    await this.saveQueue;
    this.data = {};
    this.dirtyEntries.clear();
    await this.storage.clear();
  }
}
