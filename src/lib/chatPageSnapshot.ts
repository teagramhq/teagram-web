import type {ActiveAccountNumber} from '@lib/accounts/types';
import type {ChatPhoto, UserProfilePhoto} from '@layer';
import StateStorage from '@lib/stateStorage';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import sessionStorage from '@lib/sessionStorage';
import bytesFromHex from '@helpers/bytes/bytesFromHex';
import bytesToHex from '@helpers/bytes/bytesToHex';
import {getMtprotoTarget} from '@config/mtprotoTarget';
import App from '@config/app';
import {getDatabaseState} from '@config/databases/state';
import IDBStorage from '@lib/files/idb';
import * as snapshotStorage from '@lib/chatPageSnapshotStorage';
import {scopeServerStorageKey} from '@config/serverContext';

export type ChatPageKey = {accountNumber: ActiveAccountNumber, userId: PeerId, server: string, authKeyId: string};
export type ChatPageRow = {peerId: PeerId, title: string, avatar?: ChatPhoto | UserProfilePhoto, preview: string, date: number, unread: number, markedUnread: boolean, muted: boolean, pinned: boolean};
export type ChatPageSnapshot = {key: ChatPageKey, rows: ChatPageRow[]};

let loadedSnapshot: ChatPageSnapshot;
let loadedGuard: string;
let loadGeneration = 0;
let disabled = false;
let pending = Promise.resolve();
const storages = new Map<ActiveAccountNumber, StateStorage>();
const generations = [0, 0, 0, 0, 0];
const guardKey = () => scopeServerStorageKey('chat-page-snapshot-guard');
const openGuardKey = () => scopeServerStorageKey('chat-page-snapshot-open-guard');

function readRawGuard() {
  if(typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(guardKey()) || '';
  } catch(error) {
    console.error('failed to read chat page snapshot guard', error);
    return undefined;
  }
}

function readGuard() {
  const guard = readRawGuard();
  if(!guard?.startsWith('blocked:')) return guard;
  try {
    const open = localStorage.getItem(openGuardKey()) === guard;
    if(readRawGuard() !== guard) return undefined;
    return open ? `open:${guard.slice(8)}` : guard;
  } catch(error) {
    console.error('failed to read chat page snapshot guard', error);
    return undefined;
  }
}

export function blockSnapshotReads() {
  const guard = `blocked:${crypto.randomUUID()}`;
  localStorage.setItem(guardKey(), guard);
  forgetLoadedChatPageSnapshot();
  return guard;
}

export function unblockSnapshotReads(expected: string) {
  if(expected?.startsWith('blocked:') && readRawGuard() === expected) localStorage.setItem(openGuardKey(), expected);
}

export function snapshotReadGuard() { return readRawGuard(); }

export function chatPageSnapshotGeneration(accountNumber: ActiveAccountNumber) {
  return generations[accountNumber];
}

export async function getChatPageKey(accountNumber: ActiveAccountNumber): Promise<ChatPageKey | undefined> {
  const account = await sessionStorage.getFresh(`account${accountNumber}`);
  if(!account) return;
  const authKey = account[`dc${account.dcId || App.baseDcId}_auth_key`];
  if(!account.userId || !authKey || !/^[\da-f]{512}$/i.test(authKey)) return;
  const digest = await crypto.subtle.digest('SHA-1', bytesFromHex(authKey));
  const target = getMtprotoTarget();
  return {
    accountNumber,
    userId: account.userId,
    server: target.mode === 'private' ? target.endpoint : 'telegram',
    authKeyId: bytesToHex(new Uint8Array(digest).slice(-8))
  };
}

export function sameChatPageKey(a: ChatPageKey, b: ChatPageKey) {
  return !!a && !!b && a.accountNumber === b.accountNumber && a.userId === b.userId &&
    a.server === b.server && a.authKeyId === b.authKeyId;
}

function storageFor(accountNumber: ActiveAccountNumber) {
  let storage = storages.get(accountNumber);
  if(!storage) storages.set(accountNumber, storage = new StateStorage(accountNumber));
  return storage;
}

function enqueue(operation: () => Promise<void>) {
  const result = pending.then(operation);
  pending = result.catch((error) => { console.error('chat page snapshot storage failed', error); });
  return result;
}

export function writeChatPageSnapshot(key: ChatPageKey, rows: ChatPageRow[], generation = chatPageSnapshotGeneration(key.accountNumber)) {
  return enqueue(async() => {
    const passcode = await DeferredIsUsingPasscode.isUsingPasscode();
    if(disabled || generation !== generations[key.accountNumber] || passcode) return;
    await snapshotStorage.writeSnapshot({key, rows: rows.slice(0, 20)});
  });
}

export async function loadChatPageSnapshot(key?: ChatPageKey) {
  forgetLoadedChatPageSnapshot();
  const generation = loadGeneration;
  const guard = readGuard();
  if(guard === undefined || guard.startsWith('blocked:') || !key || disabled || await DeferredIsUsingPasscode.isUsingPasscode()) return;
  const snapshot = await snapshotStorage.readSnapshot(key.accountNumber);
  if(generation === loadGeneration && guard === readGuard() && !disabled && DeferredIsUsingPasscode.isUsingPasscodeUndeferred() === false) {
    loadedSnapshot = snapshot;
    loadedGuard = guard;
  }
}

export function readChatPageSnapshot(key: ChatPageKey): ChatPageRow[] | undefined {
  const guard = readGuard();
  if(guard === undefined || guard.startsWith('blocked:') || guard !== loadedGuard || disabled ||
    DeferredIsUsingPasscode.isUsingPasscodeUndeferred() !== false || !loadedSnapshot) return;
  const saved = loadedSnapshot.key;
  if(!sameChatPageKey(saved, key) || !Array.isArray(loadedSnapshot.rows) || loadedSnapshot.rows.length > 20) return;
  return loadedSnapshot.rows;
}

export function forgetLoadedChatPageSnapshot() {
  ++loadGeneration;
  loadedSnapshot = undefined;
}

export function clearChatPageSnapshot(accountNumber: ActiveAccountNumber) {
  ++generations[accountNumber];
  forgetLoadedChatPageSnapshot();
  return enqueue(async() => {
    await snapshotStorage.clearSnapshot(accountNumber);
    await storageFor(accountNumber).delete('chatPageSnapshot');
    if(await DeferredIsUsingPasscode.isUsingPasscode()) {
      await new IDBStorage(getDatabaseState(accountNumber), 'session').delete('chatPageSnapshot');
    }
  });
}

export async function disableChatPageSnapshots(token?: string) {
  disabled = true;
  forgetLoadedChatPageSnapshot();
  await snapshotStorage.blockSnapshots(token);
  await Promise.all(([1, 2, 3, 4] as ActiveAccountNumber[]).map(clearChatPageSnapshot));
}

export async function enableChatPageSnapshots(token?: string) {
  await snapshotStorage.unblockSnapshots(token);
  disabled = false;
}
