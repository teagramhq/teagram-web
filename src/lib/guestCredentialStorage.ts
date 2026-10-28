import type {ActiveAccountNumber} from '@lib/accounts/types';
import sessionStorage from '@lib/sessionStorage';
import type {GuestCredentialRecord, GuestCredentialRecords} from '@lib/guestAccountTypes';
import {getRuntimeServerId} from '@config/serverContext';
import {notifyGuestCredentialInvalidation} from '@lib/guestCredentialBroadcast';

export async function saveGuestCredentials(records: GuestCredentialRecords) {
  if(records.length) {
    await sessionStorage.set({guestCredentials: records});
  } else {
    await sessionStorage.delete('guestCredentials');
  }
  await sessionStorage.flush();
}

export async function clearGuestCredentialsForAccount(
  userId?: PeerId,
  accountNumber?: ActiveAccountNumber,
  accountNumberOnly = false
) {
  const records = await sessionStorage.get('guestCredentials', false) || [];
  const remaining = records.filter((record: GuestCredentialRecord) => {
    const sameUser = userId !== undefined && record.accountUserId !== undefined && String(record.accountUserId) === String(userId);
    const sameAccountNumber = accountNumber !== undefined && record.accountNumber === accountNumber;
    const sameAccount = accountNumber !== undefined && record.accountNumber === accountNumber &&
      (userId === undefined || record.accountUserId === undefined);
    // Legacy records without a slot still use their user ID for cleanup.
    const matches = accountNumberOnly ? sameAccountNumber || (record.accountNumber === undefined && sameUser) : sameUser || sameAccount;
    return !matches;
  });

  if(remaining.length === records.length) return;
  await saveGuestCredentials(remaining);
  notifyGuestCredentialInvalidation();
}

export async function clearAllGuestCredentials(serverId = getRuntimeServerId()) {
  await saveGuestCredentials([]);
  notifyGuestCredentialInvalidation(serverId);
}
