import type {ActiveAccountNumber} from '@lib/accounts/types';
import AccountController from '@lib/accounts/accountController';
import {AppStoragesManager} from '@appManagers/appStoragesManager';
import commonStateStorage from '@lib/commonStateStorage';
import EncryptedStorageLayer from '@lib/encryptedStorageLayer';
import {getCommonDatabaseState} from '@config/databases/state';
import CacheStorageController from '@lib/files/cacheStorage';
import {IDB} from '@lib/files/idb';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import {saveEncryptionKeyForHandoff} from '@lib/passcode/keyHandoff';
import sessionStorage from '@lib/sessionStorage';
import type {TrueDcId} from '@types';
import {clearGuestCredentialsForAccount} from '@lib/guestCredentialStorage';

export async function clearGuestAccountLocalState(
  accountNumber: ActiveAccountNumber,
  totalAccounts: number,
  migrateAccountTo?: ActiveAccountNumber
) {
  if(totalAccounts <= 1 && accountNumber === 1 && !migrateAccountTo) {
    await Promise.all([
      (async() => {
        const keys: Parameters<typeof sessionStorage['delete']>[0][] = [
          'account1',
          'dc',
          'server_time_offset',
          'xt_instance',
          'user_auth',
          // 'state_id',
          'k_build',
          'auth_key_fingerprint'
        ];
        for(let i = 1; i <= 5; ++i) {
          keys.push(`dc${i as TrueDcId}_server_salt`);
          keys.push(`dc${i as TrueDcId}_auth_key`);
          keys.push(`dc${i as TrueDcId}_hash`); // WebA only
        }

        return Promise.all(keys.map((key) => sessionStorage.delete(key)));
      })(),
      AppStoragesManager.clearAllStoresForAccount(1),
      AppStoragesManager.clearSessionStores(),
      commonStateStorage.clear(),
      EncryptedStorageLayer.getInstance(getCommonDatabaseState(), 'localStorage__encrypted').clear(),
      CacheStorageController.deleteAllStorages()
    ]);
  } else {
    await AccountController.shiftAccounts(accountNumber);
    await AppStoragesManager.shiftStorages(accountNumber);

    if(await DeferredIsUsingPasscode.isUsingPasscode()) {
      // Keep the screen unlocked even if the user logs out: tab scoped, never on disk.
      await saveEncryptionKeyForHandoff();
    }
  }

  IDB.closeDatabases();
}

export async function clearInvalidatedGuestAccount(accountNumber: ActiveAccountNumber, userId?: PeerId) {
  const totalAccounts = await AccountController.getTotalAccounts();
  await Promise.all([
    clearGuestCredentialsForAccount(userId, accountNumber),
    clearGuestAccountLocalState(accountNumber, totalAccounts)
  ]);
}
