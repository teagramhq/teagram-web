import type {ActiveAccountNumber} from '@lib/accounts/types';
import sessionStorage from '@lib/sessionStorage';
import type {GuestCredentialRecord} from '@lib/guestAccountTypes';
import {getRuntimeServerId} from '@config/serverContext';
import {notifyGuestCredentialInvalidation} from '@lib/guestCredentialBroadcast';

export async function clearGuestCredentialsForAccount(userId?: PeerId, accountNumber?: ActiveAccountNumber) {
  const records = await sessionStorage.get('guestCredentials') || [];
  const remaining = records.filter((record: GuestCredentialRecord) => {
    const sameUser = userId !== undefined && record.accountUserId !== undefined && String(record.accountUserId) === String(userId);
    const sameAccount = accountNumber !== undefined && record.accountNumber === accountNumber &&
      (userId === undefined || record.accountUserId === undefined);
    return !sameUser && !sameAccount;
  });

  if(remaining.length === records.length) return;
  if(remaining.length) {
    await sessionStorage.set({guestCredentials: remaining});
  } else {
    await sessionStorage.delete('guestCredentials');
  }
  notifyGuestCredentialInvalidation();
}

export async function clearAllGuestCredentials(serverId = getRuntimeServerId()) {
  await sessionStorage.delete('guestCredentials');
  notifyGuestCredentialInvalidation(serverId);
}
