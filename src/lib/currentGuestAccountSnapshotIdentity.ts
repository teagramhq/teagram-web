import AccountController from '@lib/accounts/accountController';
import {getCurrentAccount} from '@lib/accounts/getCurrentAccount';
import sessionStorage from '@lib/sessionStorage';
import {getGuestCredentialRecords} from '@lib/guestAccountRecords';
import {getActiveGuestServerIdentity, isGuestServerIdentityCurrent} from '@lib/guestAccountIdentity';
import {createGuestAccountServerLock} from '@lib/guestAccountLock';
import {hasGuestWipeGenerationChanged, isGuestSnapshotIdentityCurrent} from '@lib/guestAccountSnapshotIdentity';
import {listenForGuestCredentialInvalidation} from '@lib/guestCredentialBroadcast';
import type {GuestServerIdentity} from '@lib/guestAccountTypes';
import type {GuestSnapshotIdentityCancellation, GuestSnapshotIdentityDependencies} from '@lib/guestAccountSnapshotIdentity';

function createDependencies(): GuestSnapshotIdentityDependencies {
  return {
    getCurrentAccountNumber: getCurrentAccount,
    getAccountUserId: async(accountNumber) => (await AccountController.get(accountNumber)).userId,
    readRecords: async() => getGuestCredentialRecords(await sessionStorage.get('guestCredentials', false)),
    isContextCurrent: (context) => getCurrentAccount() === context.accountNumber && isGuestServerIdentityCurrent(context)
  };
}

async function withCurrentGuestAccountLock<T>(identity: GuestServerIdentity, callback: (cancelled: GuestSnapshotIdentityCancellation) => Promise<T>) {
  return createGuestAccountServerLock(`teagram:guest-account:${identity.serverId}`, async() => {
    const cancelled = {value: false};
    const unsubscribe = listenForGuestCredentialInvalidation(identity.serverId, () => {
      cancelled.value = true;
    });
    try {
      return await callback(cancelled);
    } finally {
      unsubscribe();
    }
  });
}

export function isCurrentGuestSnapshotIdentity() {
  const identity = getActiveGuestServerIdentity();
  return withCurrentGuestAccountLock(identity, (cancelled) =>
    isGuestSnapshotIdentityCurrent(identity, cancelled, createDependencies())
  );
}

export function hasCurrentGuestWipeGenerationChanged() {
  const identity = getActiveGuestServerIdentity();
  return withCurrentGuestAccountLock(identity, (cancelled) =>
    hasGuestWipeGenerationChanged(identity, cancelled, createDependencies())
  );
}
