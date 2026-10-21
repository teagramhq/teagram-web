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

export async function clearGuestCredentialsForAccount(userId?: PeerId, accountNumber?: ActiveAccountNumber) {
  const records = await sessionStorage.get('guestCredentials', false) || [];
  const remaining = records.filter((record: GuestCredentialRecord) => {
    const sameUser = userId !== undefined && record.accountUserId !== undefined && String(record.accountUserId) === String(userId);
    const sameAccount = accountNumber !== undefined && record.accountNumber === accountNumber &&
      (userId === undefined || record.accountUserId === undefined);
    return !sameUser && !sameAccount;
  });

  if(remaining.length === records.length) return;
  await saveGuestCredentials(remaining);
  notifyGuestCredentialInvalidation();
}

export async function clearAllGuestCredentials(serverId = getRuntimeServerId()) {
  await saveGuestCredentials([]);
  notifyGuestCredentialInvalidation(serverId);
}
