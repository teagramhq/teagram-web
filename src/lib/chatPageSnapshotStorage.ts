import {getCommonDatabaseState} from '@config/databases/state';
import {IDB} from '@lib/files/idb';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import type {ChatPageSnapshot} from '@lib/chatPageSnapshot';

const blockedKey = 'chatPageSnapshotsBlocked';
const snapshotKey = (accountNumber: ActiveAccountNumber) => `chatPageSnapshot:${accountNumber}`;
const epochKey = (accountNumber: ActiveAccountNumber) => `chatPageSnapshotEpoch:${accountNumber}`;
type Epoch = {id: string, invalidations: string[]};

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

export async function captureSnapshotEpoch(accountNumber: ActiveAccountNumber) {
  let epoch: string;
  await transaction('readwrite', (store) => {
    const request = store.get(epochKey(accountNumber));
    request.onsuccess = () => {
      const current: Epoch = request.result || {id: crypto.randomUUID(), invalidations: []};
      if(!request.result) store.put(current, epochKey(accountNumber));
      if(!current.invalidations.length) epoch = current.id;
    };
  });
  return epoch;
}

export function writeSnapshot(snapshot: ChatPageSnapshot, epoch: string) {
  return transaction('readwrite', (store) => {
    const blocked = store.get(blockedKey);
    const current = store.get(epochKey(snapshot.key.accountNumber));
    current.onsuccess = () => {
      const state: Epoch = current.result;
      if(!blocked.result && epoch && state?.id === epoch && !state.invalidations.length) {
        store.put(snapshot, snapshotKey(snapshot.key.accountNumber));
      }
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
  return invalidateSnapshot(accountNumber, false);
}

export async function invalidateSnapshot(accountNumber: ActiveAccountNumber, hold: boolean) {
  const token = hold ? crypto.randomUUID() : undefined;
  await transaction('readwrite', (store) => {
    const request = store.get(epochKey(accountNumber));
    request.onsuccess = () => {
      const invalidations: string[] = request.result?.invalidations || [];
      if(token) invalidations.push(token);
      store.put({id: crypto.randomUUID(), invalidations} satisfies Epoch, epochKey(accountNumber));
      store.delete(snapshotKey(accountNumber));
    };
  });
  return token;
}

export function finishInvalidation(accountNumber: ActiveAccountNumber, token: string) {
  return transaction('readwrite', (store) => {
    const request = store.get(epochKey(accountNumber));
    request.onsuccess = () => {
      const state: Epoch = request.result;
      if(state) store.put({...state, invalidations: state.invalidations.filter((value) => value !== token)}, epochKey(accountNumber));
    };
  });
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
