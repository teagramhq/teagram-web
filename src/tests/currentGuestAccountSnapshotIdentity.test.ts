import {beforeEach, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  currentAccount: 1,
  changeAccountWhileReading: false,
  accountUserId: '123',
  accountLookupError: undefined as Error | undefined,
  credentialReadError: undefined as Error | undefined,
  serverLockError: undefined as Error | undefined,
  identity: {serverId: 'server-id', keyFingerprint: 'fingerprint', wipeGeneration: 'generation-1'},
  records: [{
    version: 1,
    serverId: 'server-id',
    keyFingerprint: 'fingerprint',
    username: 'guest_abcdefghijklmnop',
    password: 'A'.repeat(43),
    status: 'committed',
    wipeGeneration: 'generation-1',
    accountUserId: '123',
    accountNumber: 1
  }]
}));

vi.mock('@lib/accounts/accountController', () => ({default: {get: async() => {
  if(mocks.accountLookupError) throw mocks.accountLookupError;
  return {userId: mocks.accountUserId};
}}}));
vi.mock('@lib/accounts/getCurrentAccount', () => ({getCurrentAccount: () => mocks.currentAccount}));
vi.mock('@lib/sessionStorage', () => ({default: {get: async() => {
  if(mocks.credentialReadError) throw mocks.credentialReadError;
  if(mocks.changeAccountWhileReading) {
    mocks.changeAccountWhileReading = false;
    mocks.currentAccount = 2;
  }
  return mocks.records;
}}}));
vi.mock('@lib/guestAccountRecords', () => ({
  chooseGuestCredentialRecord: (records: any[], context: any) => records.find((record) =>
    record.serverId === context.serverId && record.keyFingerprint === context.keyFingerprint &&
    String(record.accountUserId) === String(context.accountUserId)
  ),
  getGuestCredentialRecords: (records: any[]) => records,
  sameGuestUserId: (left?: PeerId, right?: PeerId) => left !== undefined && right !== undefined && String(left) === String(right)
}));
vi.mock('@lib/guestAccountIdentity', () => ({
  getActiveGuestServerIdentity: () => mocks.identity,
  isGuestServerIdentityCurrent: () => true
}));
vi.mock('@lib/guestCredentialBroadcast', () => ({listenForGuestCredentialInvalidation: () => () => {}}));
vi.mock('@lib/guestAccountLock', () => ({createGuestAccountServerLock: async(_key: string, callback: () => Promise<unknown>) => {
  if(mocks.serverLockError) throw mocks.serverLockError;
  return callback();
}}));

import {hasCurrentGuestWipeGenerationChanged, isCurrentAccountGuest} from '@lib/currentGuestAccountSnapshotIdentity';

beforeEach(() => {
  mocks.currentAccount = 1;
  mocks.changeAccountWhileReading = false;
  mocks.accountUserId = '123';
  mocks.accountLookupError = undefined;
  mocks.credentialReadError = undefined;
  mocks.serverLockError = undefined;
  mocks.identity = {serverId: 'server-id', keyFingerprint: 'fingerprint', wipeGeneration: 'generation-1'};
  mocks.records = [{
    version: 1,
    serverId: 'server-id',
    keyFingerprint: 'fingerprint',
    username: 'guest_abcdefghijklmnop',
    password: 'A'.repeat(43),
    status: 'committed',
    wipeGeneration: 'generation-1',
    accountUserId: '123',
    accountNumber: 1
  }];
});

it('recognizes a saved guest only for the active account and server identity', async() => {
  await expect(isCurrentAccountGuest()).resolves.toBe(true);

  mocks.identity = {...mocks.identity, keyFingerprint: 'other-fingerprint'};
  await expect(isCurrentAccountGuest()).resolves.toBe(false);
});

it('uses a confirmed login user id and rejects a changed account context', async() => {
  await expect(isCurrentAccountGuest(123 as PeerId)).resolves.toBe(true);

  mocks.changeAccountWhileReading = true;
  await expect(isCurrentAccountGuest(123 as PeerId)).resolves.toBe(false);
});

it('propagates server-lock failures when checking the current guest wipe generation', async() => {
  const error = new Error('guest lock unavailable');
  mocks.serverLockError = error;

  await expect(hasCurrentGuestWipeGenerationChanged()).rejects.toBe(error);
});

it('propagates account-lookup failures when checking the current guest wipe generation', async() => {
  const error = new Error('account lookup failed');
  mocks.accountLookupError = error;

  await expect(hasCurrentGuestWipeGenerationChanged()).rejects.toBe(error);
});

it('propagates credential-read failures when checking the current guest wipe generation', async() => {
  const error = new Error('credential read failed');
  mocks.credentialReadError = error;

  await expect(hasCurrentGuestWipeGenerationChanged()).rejects.toBe(error);
});
