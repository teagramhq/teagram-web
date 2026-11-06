import type {ActiveAccountNumber} from '@lib/accounts/types';
import {chooseGuestCredentialRecord} from '@lib/guestAccountRecords';
import type {GuestAccountContext, GuestCredentialRecords, GuestServerIdentity} from '@lib/guestAccountTypes';

export type GuestSnapshotIdentityCancellation = {value: boolean};

export type GuestSnapshotIdentityDependencies = {
  getCurrentAccountNumber: () => ActiveAccountNumber,
  getAccountUserId: (accountNumber: ActiveAccountNumber) => Promise<PeerId | undefined>,
  readRecords: () => Promise<GuestCredentialRecords>,
  isContextCurrent: (context: GuestAccountContext) => boolean
};

export async function isGuestSnapshotIdentityCurrent(
  identity: GuestServerIdentity,
  cancelled: GuestSnapshotIdentityCancellation,
  dependencies: GuestSnapshotIdentityDependencies
) {
  const rejectSnapshot = (reason: string) => {
    console.error('guest snapshot identity mismatch', reason);
    return false;
  };
  if(!identity.wipeGeneration) return rejectSnapshot('wipe generation unavailable');

  const accountNumber = dependencies.getCurrentAccountNumber();
  const accountUserId = await dependencies.getAccountUserId(accountNumber);
  if(accountUserId === undefined) return rejectSnapshot('account user id unavailable');
  const context: GuestAccountContext = {...identity, accountNumber, accountUserId};
  if(cancelled.value || !dependencies.isContextCurrent(context)) {
    return rejectSnapshot('guest context changed before reading credentials');
  }

  const record = chooseGuestCredentialRecord(await dependencies.readRecords(), context);
  if(!record) return false;
  if(record.status !== 'committed') return rejectSnapshot('guest record is not committed');
  if(record.wipeGeneration !== identity.wipeGeneration) return rejectSnapshot('wipe generation mismatch');
  if(record.accountNumber !== undefined && record.accountNumber !== accountNumber) return rejectSnapshot('account number mismatch');
  if(record.accountUserId === undefined) return rejectSnapshot('guest record account user id unavailable');
  if(String(record.accountUserId) !== String(accountUserId)) return rejectSnapshot('guest record account user id mismatch');

  const currentUserId = await dependencies.getAccountUserId(accountNumber);
  if(cancelled.value || !dependencies.isContextCurrent(context)) {
    return rejectSnapshot('guest context changed during verification');
  }
  if(String(currentUserId) !== String(accountUserId)) return rejectSnapshot('account user changed during verification');
  return true;
}

export async function hasGuestWipeGenerationChanged(
  identity: GuestServerIdentity,
  cancelled: GuestSnapshotIdentityCancellation,
  dependencies: GuestSnapshotIdentityDependencies
) {
  const accountNumber = dependencies.getCurrentAccountNumber();
  const accountUserId = await dependencies.getAccountUserId(accountNumber);
  const context: GuestAccountContext = {...identity, accountNumber, accountUserId};
  if(!dependencies.isContextCurrent(context)) return false;
  const record = chooseGuestCredentialRecord(await dependencies.readRecords(), context);
  if(cancelled.value || !dependencies.isContextCurrent(context)) return false;
  return !!record && identity.wipeGeneration !== undefined && record.wipeGeneration !== undefined &&
    identity.wipeGeneration !== record.wipeGeneration;
}
