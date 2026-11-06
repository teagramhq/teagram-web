import {getCommonDatabaseState} from '@config/databases/state';
import {IDB} from '@lib/files/idb';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import type {ChatPageSnapshot} from '@lib/chatPageSnapshot';

const blockedKey = 'chatPageSnapshotsBlocked';
const snapshotKey = (accountNumber: ActiveAccountNumber) => `chatPageSnapshot:${accountNumber}`;

async function transaction(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void) {
  const db = await IDB.create(getCommonDatabaseState()).openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('session', mode, {durability: 'strict'});
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Chat page snapshot transaction aborted'));
    tx.onerror = () => reject(tx.error);
    try {
      run(tx.objectStore('session'));
    } catch(error) {
      tx.abort();
      reject(error);
    }
  });
}

export function writeSnapshot(snapshot: ChatPageSnapshot) {
  return transaction('readwrite', (store) => {
    const blocked = store.get(blockedKey);
    blocked.onsuccess = () => {
      if(!blocked.result) store.put(snapshot, snapshotKey(snapshot.key.accountNumber));
    };
  });
}

export async function readSnapshot(accountNumber: ActiveAccountNumber) {
  let snapshot: ChatPageSnapshot;
  await transaction('readonly', (store) => {
    const blocked = store.get(blockedKey);
    const value = store.get(snapshotKey(accountNumber));
    value.onsuccess = () => { if(!blocked.result) snapshot = value.result; };
  });
  return snapshot;
}

export function clearSnapshot(accountNumber: ActiveAccountNumber) {
  return transaction('readwrite', (store) => { store.delete(snapshotKey(accountNumber)); });
}

export function blockSnapshots(token?: string) {
  return transaction('readwrite', (store) => {
    const previous = store.get(blockedKey);
    previous.onsuccess = () => { store.put(token || previous.result || 'legacy', blockedKey); };
    for(const account of [1, 2, 3, 4] as ActiveAccountNumber[]) store.delete(snapshotKey(account));
  });
}

export async function unblockSnapshots(token?: string) {
  let allowed = false;
  await transaction('readwrite', (store) => {
    const blocked = store.get(blockedKey);
    const settings = store.get('settings');
    const passcode = store.get('passcode');
    passcode.onsuccess = () => {
      if(!settings.result?.passcode?.enabled && !passcode.result &&
        (!blocked.result || blocked.result === 'legacy' || blocked.result === token)) {
        store.delete(blockedKey);
        allowed = true;
      }
    };
  });
  if(!allowed) throw new Error('Chat page snapshots are still blocked');
}
