import type {DcId} from '@types';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getServerStoragePrefix} from '@config/serverContext';
import makeError from '@helpers/makeError';

type AuthKeyAccount = Record<string, any> & {userId?: PeerId};

type RecoveryOptions = {
  accountNumber: ActiveAccountNumber,
  dcId: DcId,
  isRejectedAuthKey: (authKeyHex: string) => boolean,
  isNetworkerCurrent: () => boolean,
  readAccount: () => Promise<AuthKeyAccount>,
  writeAccount: (account: AuthKeyAccount) => Promise<boolean | void>,
  exchangeAuthKey: () => Promise<{authKeyHex: string, serverSaltHex: string}>,
  invalidateRejectedKey: () => void
};

function isAuthKeyHex(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{512}$/i.test(value);
}

function isServerSaltHex(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{16}$/i.test(value);
}

export function getAuthKeyRecoveryLockName(accountNumber: ActiveAccountNumber, dcId: DcId) {
  return `${getServerStoragePrefix()}auth-key-recovery:${accountNumber}:${dcId}`;
}

export function withAuthKeyRecoveryLock<T>(
  accountNumber: ActiveAccountNumber,
  dcId: DcId,
  callback: () => Promise<T>
): Promise<T> {
  if(typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.reject(makeError('AUTH_KEY_UNKNOWN'));
  }

  return navigator.locks.request(getAuthKeyRecoveryLockName(accountNumber, dcId), callback);
}

export function recoverRejectedAuthKey(options: RecoveryOptions): Promise<boolean> {
  const {accountNumber, dcId} = options;
  const authKeyName = `dc${dcId}_auth_key`;
  const serverSaltName = `dc${dcId}_server_salt`;
  return withAuthKeyRecoveryLock(accountNumber, dcId, async() => {
    const account = await options.readAccount() || {};
    if(account.userId) return false;

    const storedAuthKey = account[authKeyName];
    if(isAuthKeyHex(storedAuthKey) && !options.isRejectedAuthKey(storedAuthKey)) {
      if(options.isNetworkerCurrent()) options.invalidateRejectedKey();
      return true;
    }
    if(storedAuthKey && !isAuthKeyHex(storedAuthKey)) return false;
    if(!options.isNetworkerCurrent()) return false;

    if(isAuthKeyHex(storedAuthKey)) {
      delete account[authKeyName];
      delete account[serverSaltName];
      if(await options.writeAccount(account) === false) return false;
    }

    options.invalidateRejectedKey();
    const replacement = await options.exchangeAuthKey();
    if(!isAuthKeyHex(replacement.authKeyHex) || !isServerSaltHex(replacement.serverSaltHex)) {
      throw makeError('AUTH_KEY_UNKNOWN');
    }

    const latestAccount = await options.readAccount() || {};
    if(latestAccount.userId) return false;

    const latestAuthKey = latestAccount[authKeyName];
    if(isAuthKeyHex(latestAuthKey) && !options.isRejectedAuthKey(latestAuthKey)) return true;
    if(latestAuthKey && !isAuthKeyHex(latestAuthKey)) return false;

    if(isAuthKeyHex(latestAuthKey)) {
      delete latestAccount[authKeyName];
      delete latestAccount[serverSaltName];
    }

    latestAccount[authKeyName] = replacement.authKeyHex;
    latestAccount[serverSaltName] = replacement.serverSaltHex;
    if(await options.writeAccount(latestAccount) === false) return false;
    return true;
  });
}
