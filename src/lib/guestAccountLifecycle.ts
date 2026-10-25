import type {AccountPassword, HelpTermsOfService, InputCheckPasswordSRP, User} from '@layer';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {authenticatePrivateUsername} from '@/pages/privateUsernameAuth';
import type {PrivateUsernameAuthResult, PrivateUsernameRegistration} from '@/pages/privateUsernameAuth';
import type {RequestTurnstileChallenge} from '@/pages/turnstileSignup';
import type {GuestCredentialRecord, GuestCredentialRecords} from '@lib/guestAccountTypes';
import {listenForGuestCredentialInvalidation, notifyGuestCredentialInvalidation} from '@lib/guestCredentialBroadcast';
import AccountController from '@lib/accounts/accountController';
import {getCurrentAccount} from '@lib/accounts/getCurrentAccount';
import {getActiveDemoWipeGeneration, getActiveServerHost, getRuntimeServerId} from '@config/serverContext';
import {getServerPin} from '@config/serverSelection';
import {getMtprotoTarget} from '@config/mtprotoTarget';
import {saveGuestCredentials} from '@lib/guestCredentialStorage';
import sessionStorage from '@lib/sessionStorage';

const GUEST_USERNAME_PATTERN = /^guest_[a-z2-7]{16}$/;
const GUEST_PASSWORD_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export type GuestServerIdentity = {
  serverId: string,
  keyFingerprint: string,
  wipeGeneration?: string
};

export type GuestAccountContext = GuestServerIdentity & {
  accountNumber: ActiveAccountNumber,
  accountUserId?: PeerId
};

export type GuestAccountLifecycleResult =
  | {kind: 'authorized', user: User, username: string}
  | {kind: 'resumed', username: string, userId: PeerId}
  | {kind: 'existing', username: string, userId?: PeerId}
  | {kind: 'forgotten'}
  | {kind: 'unrecoverable', username: string}
  | {kind: 'collisionsExhausted'}
  | {kind: 'accountInUse'}
  | {kind: 'noGuest'}
  | {kind: 'wiped'}
  | {kind: 'setupPending', username: string, errorType?: string}
  | {kind: 'termsDeclined'}
  | {kind: 'cancelled'}
  | {kind: 'error', errorType?: string};

export type GuestCredentialPair = {
  username: string,
  password: string
};

export type GuestAccountLifecycleDependencies = {
  getServerIdentity: () => GuestServerIdentity,
  isServerIdentityCurrent: (identity: GuestServerIdentity) => boolean,
  getCurrentAccountNumber: () => ActiveAccountNumber,
  getAccountUserId: (accountNumber: ActiveAccountNumber) => Promise<PeerId | undefined>,
  readCredentials: () => Promise<GuestCredentialRecords | undefined>,
  writeCredentials: (records: GuestCredentialRecords) => Promise<void>,
  clearInvalidatedAccount: (accountNumber: ActiveAccountNumber, userId?: PeerId) => Promise<void>,
  withServerLock: <T>(name: string, callback: () => Promise<T>) => Promise<T>,
  generateCredentials?: () => GuestCredentialPair,
  invokeApi: (method: any, params?: any, options?: any) => Promise<any>,
  setUser: (user: User) => Promise<void>,
  updatePasswordSettings: (password: string) => Promise<unknown>,
  verifyPassword: (password: string) => Promise<boolean>,
  signInWithPassword: (password: string) => Promise<User | false | undefined>,
  requestTurnstile?: RequestTurnstileChallenge,
  turnstileSiteKey?: string,
  requestTermsAcceptance?: (terms: HelpTermsOfService) => Promise<boolean>,
  logOut?: (accountNumber: ActiveAccountNumber) => Promise<unknown>,
  notifyInvalidation?: (serverId: string) => void,
  subscribeInvalidation?: (serverId: string, callback: () => void) => () => void
};

function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeBase32(bytes: Uint8Array) {
  let output = '';
  let buffer = 0;
  let bits = 0;
  bytes.forEach((byte) => {
    buffer = buffer << 8 | byte;
    bits += 8;
    while(bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[buffer >>> bits & 31];
    }
  });
  if(bits) output += BASE32_ALPHABET[buffer << 5 - bits & 31];
  return output;
}

export function generateGuestCredentials(): GuestCredentialPair {
  const usernameEntropy = crypto.getRandomValues(new Uint8Array(10));
  const passwordEntropy = crypto.getRandomValues(new Uint8Array(32));
  return {
    username: `guest_${encodeBase32(usernameEntropy)}`,
    password: toBase64Url(passwordEntropy)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getErrorType(error: unknown) {
  return isRecord(error) && typeof error.type === 'string' ? error.type : undefined;
}

function sameUserId(left?: PeerId, right?: PeerId) {
  return left === undefined ? right === undefined : right !== undefined && String(left) === String(right);
}

function isCredentialRecord(value: unknown): value is GuestCredentialRecord {
  if(!isRecord(value)) return false;
  return value.version === 1 && typeof value.serverId === 'string' && !!value.serverId &&
    typeof value.keyFingerprint === 'string' && !!value.keyFingerprint &&
    typeof value.username === 'string' && GUEST_USERNAME_PATTERN.test(value.username) &&
    typeof value.password === 'string' && GUEST_PASSWORD_PATTERN.test(value.password) &&
    (value.status === 'provisional' || value.status === 'committed') &&
    (value.wipeGeneration === undefined || typeof value.wipeGeneration === 'string') &&
    (value.accountUserId === undefined || typeof value.accountUserId === 'string' || typeof value.accountUserId === 'number') &&
    (value.accountNumber === undefined || value.accountNumber === 1 || value.accountNumber === 2 ||
      value.accountNumber === 3 || value.accountNumber === 4);
}

function resultFromAuthError(result: PrivateUsernameAuthResult): GuestAccountLifecycleResult {
  if(result.kind === 'error' || result.kind === 'termsAcceptanceError') {
    return result.errorType ? {kind: 'error', errorType: result.errorType} : {kind: 'error'};
  }
  if(result.kind === 'termsDeclined') return {kind: 'termsDeclined'};
  return {kind: 'error'};
}

function matchingRecords(records: GuestCredentialRecords, identity: GuestServerIdentity) {
  return records.filter((record) => record.serverId === identity.serverId && record.keyFingerprint === identity.keyFingerprint);
}

function chooseRecord(records: GuestCredentialRecords, context: GuestAccountContext) {
  const scoped = matchingRecords(records, context);
  if(context.accountUserId !== undefined) {
    const accountRecord = scoped.find((record) => sameUserId(record.accountUserId, context.accountUserId));
    if(accountRecord) return accountRecord;
    return undefined;
  }
  return scoped.find((record) => record.accountNumber === context.accountNumber) || (scoped.length === 1 ? scoped[0] : undefined);
}

function getRecords(value: unknown): GuestCredentialRecords {
  if(value === undefined) return [];
  if(!Array.isArray(value) || !value.every(isCredentialRecord)) {
    throw Object.assign(new Error('Guest credential storage is invalid'), {type: 'GUEST_CREDENTIAL_STORAGE_INVALID'});
  }
  return value;
}

export function createGuestAccountLifecycle(dependencies: GuestAccountLifecycleDependencies) {
  const notifyInvalidation = dependencies.notifyInvalidation || notifyGuestCredentialInvalidation;
  const subscribeInvalidation = dependencies.subscribeInvalidation || listenForGuestCredentialInvalidation;
  const generate = dependencies.generateCredentials || generateGuestCredentials;

  async function readRecords() {
    return getRecords(await dependencies.readCredentials());
  }

  async function saveRecord(record: GuestCredentialRecord, previousUsername?: string) {
    const records = await readRecords();
    const index = records.findIndex((candidate) => candidate.serverId === record.serverId &&
      candidate.keyFingerprint === record.keyFingerprint &&
      (candidate.username === (previousUsername || record.username) ||
        (record.accountUserId !== undefined && sameUserId(candidate.accountUserId, record.accountUserId))));
    if(index >= 0) records[index] = record;
    else records.push(record);
    await dependencies.writeCredentials(records);
  }

  async function removeRecord(record: GuestCredentialRecord) {
    const records = await readRecords();
    await dependencies.writeCredentials(records.filter((candidate) =>
      !(candidate.serverId === record.serverId && candidate.keyFingerprint === record.keyFingerprint &&
        (candidate.username === record.username || (record.accountUserId !== undefined && sameUserId(candidate.accountUserId, record.accountUserId))))
    ));
  }

  async function clearInvalidatedRecord(record: GuestCredentialRecord, context: GuestAccountContext, cancelled: {value: boolean}) {
    await assertContext(context, context.accountUserId, cancelled);
    record.password = '';
    await dependencies.clearInvalidatedAccount(context.accountNumber, record.accountUserId ?? context.accountUserId);
    notifyInvalidation(context.serverId);
  }

  function isContextCurrent(context: GuestAccountContext) {
    return dependencies.getCurrentAccountNumber() === context.accountNumber &&
      dependencies.isServerIdentityCurrent(context);
  }

  async function assertContext(context: GuestAccountContext, accountUserId?: PeerId, cancelled?: {value: boolean}) {
    if(cancelled?.value || !isContextCurrent(context)) {
      throw Object.assign(new Error('Guest account flow was cancelled'), {type: 'GUEST_CANCELLED'});
    }
    const currentUserId = await dependencies.getAccountUserId(context.accountNumber);
    if(cancelled?.value || !sameUserId(currentUserId, accountUserId) || !isContextCurrent(context)) {
      throw Object.assign(new Error('Guest account flow was cancelled'), {type: 'GUEST_CANCELLED'});
    }
  }

  async function createOrResumeLocked(identity: GuestServerIdentity, cancelled: {value: boolean, record?: GuestCredentialRecord, registration?: PrivateUsernameRegistration}) {
    if(!dependencies.isServerIdentityCurrent(identity)) return {kind: 'cancelled'} as const;
    const accountNumber = dependencies.getCurrentAccountNumber();
    const accountUserId = await dependencies.getAccountUserId(accountNumber);
    const context: GuestAccountContext = {...identity, accountNumber, accountUserId};
    if(!isContextCurrent(context)) return {kind: 'cancelled'} as const;

    const records = await readRecords();
    if(cancelled.value || !isContextCurrent(context)) return {kind: 'cancelled'} as const;
    let record = chooseRecord(records, context);
    const resumingStoredRecord = !!record;
    if(record?.status === 'committed') {
      return {kind: 'existing', username: record.username, userId: record.accountUserId} as const;
    }
    if(accountUserId !== undefined && (!record || !sameUserId(accountUserId, record.accountUserId))) {
      return {kind: 'accountInUse'} as const;
    }

    if(!record) {
      const scoped = matchingRecords(records, identity);
      if(scoped.length) {
        const existing = accountUserId === undefined ? scoped[0] :
          scoped.find((candidate) => sameUserId(candidate.accountUserId, accountUserId));
        if(!existing) return {kind: 'accountInUse'} as const;
        return {kind: 'existing', username: existing.username, userId: existing.accountUserId} as const;
      }
      const generated = generate();
      record = {
        version: 1,
        serverId: identity.serverId,
        keyFingerprint: identity.keyFingerprint,
        username: generated.username,
        password: generated.password,
        status: 'provisional',
        ...(identity.wipeGeneration !== undefined ? {wipeGeneration: identity.wipeGeneration} : {}),
        accountNumber
      };
      await assertContext(context, accountUserId, cancelled);
      await saveRecord(record);
      cancelled.record = record;
    }

    const activeUserId = accountUserId;
    const recordUserId = record.accountUserId;
    let boundUserId = activeUserId;
    const isCancelled = () => cancelled.value || !isContextCurrent(context);

    const updatePassword = async(password: string) => {
      await assertContext(context, boundUserId, cancelled);
      try {
        const result = await dependencies.updatePasswordSettings(password);
        if(result === false) return false;
      } catch(error) {
        if(getErrorType(error) !== 'PASSWORD_HASH_INVALID') throw error;
        const verified = await dependencies.verifyPassword(password);
        if(!verified) return false;
      }
      await assertContext(context, boundUserId, cancelled);
      return true;
    };

    const onAuthorization = async(user: User) => {
      await assertContext(context, boundUserId, cancelled);
      const expectedUserId = boundUserId ?? record!.accountUserId;
      if(expectedUserId !== undefined && !sameUserId(expectedUserId, user.id as PeerId)) {
        throw Object.assign(new Error('Guest account identity changed'), {type: 'GUEST_ACCOUNT_MISMATCH'});
      }
      await dependencies.setUser(user);
      boundUserId = user.id as PeerId;
      record = {...record!, accountUserId: boundUserId, accountNumber: context.accountNumber};
      cancelled.record = record;
      await assertContext(context, boundUserId, cancelled);
      await saveRecord(record);
    };

    if(record.status === 'provisional' && activeUserId !== undefined && sameUserId(activeUserId, recordUserId)) {
      cancelled.record = record;
      try {
        const saved = await updatePassword(record.password);
        if(!saved) return {kind: 'setupPending', username: record.username} as const;
        await assertContext(context, boundUserId, cancelled);
        record = {...record, status: 'committed', accountNumber: context.accountNumber};
        await saveRecord(record);
        return {kind: 'resumed', username: record.username, userId: record.accountUserId!} as const;
      } catch(error) {
        if(getErrorType(error) === 'GUEST_CANCELLED') return {kind: 'cancelled'} as const;
        const errorType = getErrorType(error);
        return errorType ? {kind: 'setupPending', username: record.username, errorType} as const :
          {kind: 'setupPending', username: record.username} as const;
      }
    }

    for(let attempt = 0; attempt < 3; ++attempt) {
      await assertContext(context, boundUserId, cancelled);
      const resuming = attempt === 0 && resumingStoredRecord;
      const registration: PrivateUsernameRegistration = {
        mode: 'open',
        displayName: 'Guest',
        password: record.password,
        updatePasswordSettings: updatePassword,
        requestTermsAcceptance: dependencies.requestTermsAcceptance,
        onAuthorization,
        checkPassword: resuming ? async(password) => {
          await assertContext(context, boundUserId, cancelled);
          const user = await dependencies.signInWithPassword(password);
          if(!user) return false;
          return user;
        } : undefined
      };
      cancelled.registration = registration;
      let result: PrivateUsernameAuthResult;
      try {
        result = await authenticatePrivateUsername(
          record.username,
          dependencies.invokeApi,
          isCancelled,
          registration,
          dependencies.requestTurnstile,
          dependencies.turnstileSiteKey
        );
      } catch(error) {
        const errorType = getErrorType(error);
        if(errorType === 'GUEST_CANCELLED') return {kind: 'cancelled'} as const;
        return errorType ? {kind: 'error', errorType} as const : {kind: 'error'} as const;
      }
      if(cancelled.value || !isContextCurrent(context)) return {kind: 'cancelled'} as const;

      if(result.kind === 'authorized') {
        try {
          await assertContext(context, boundUserId, cancelled);
          if(record.accountUserId === undefined) {
            record = {...record, accountUserId: result.user.id as PeerId, accountNumber: context.accountNumber};
          }
          record = {...record, status: 'committed'};
          await saveRecord(record);
          return {kind: 'authorized', user: result.user, username: record.username} as const;
        } catch(error) {
          return getErrorType(error) === 'GUEST_CANCELLED' ? {kind: 'cancelled'} as const : {kind: 'error'} as const;
        }
      }
      if(result.kind === 'cancelled') return {kind: 'cancelled'} as const;
      if(result.kind === 'termsDeclined' || result.kind === 'termsAcceptanceError') {
        await removeRecord(record);
        record.password = '';
        return resultFromAuthError(result);
      }
      if(result.kind === 'usernameTaken') {
        if(record.accountUserId !== undefined) return {kind: 'unrecoverable', username: record.username} as const;
        if(attempt === 2) {
          await removeRecord(record);
          return {kind: 'collisionsExhausted'} as const;
        }
        const previousUsername = record.username;
        const generated = generate();
        record = {
          ...record,
          username: generated.username,
          password: generated.password,
          accountUserId: undefined,
          accountNumber: context.accountNumber,
          ...(identity.wipeGeneration !== undefined ? {wipeGeneration: identity.wipeGeneration} : {}),
          status: 'provisional'
        };
        cancelled.record = record;
        await assertContext(context, boundUserId, cancelled);
        await saveRecord(record, previousUsername);
        continue;
      }
      if(result.kind === 'passwordSetupError' || result.kind === 'weakPassword') {
        return {kind: 'setupPending', username: record.username, ...('errorType' in result && result.errorType ? {errorType: result.errorType} : {})} as const;
      }
      if(record.status === 'provisional' && (result.kind === 'invalidCredentials' ||
        ('errorType' in result && result.errorType === 'INTERNAL' && (record.accountUserId !== undefined || (attempt === 0 && resumingStoredRecord))))) {
        return {kind: 'unrecoverable', username: record.username} as const;
      }
      return resultFromAuthError(result);
    }

    return {kind: 'collisionsExhausted'} as const;
  }

  async function runLocked<T>(identity: GuestServerIdentity, callback: (cancelled: {value: boolean, record?: GuestCredentialRecord, registration?: PrivateUsernameRegistration}) => Promise<T>) {
    return dependencies.withServerLock(`teagram:guest-account:${identity.serverId}`, async() => {
      const cancelled = {value: false} as {value: boolean, record?: GuestCredentialRecord, registration?: PrivateUsernameRegistration};
      const unsubscribe = subscribeInvalidation(identity.serverId, () => {
        cancelled.value = true;
        if(cancelled.record) cancelled.record.password = '';
        if(cancelled.registration) cancelled.registration.password = '';
      });
      try {
        return await callback(cancelled);
      } finally {
        unsubscribe();
      }
    });
  }

  return {
    async create() {
      let identity: GuestServerIdentity;
      try {
        identity = dependencies.getServerIdentity();
      } catch(error) {
        const errorType = getErrorType(error);
        return errorType ? {kind: 'error', errorType} as const : {kind: 'error'} as const;
      }
      try {
        return await runLocked(identity, (cancelled) => createOrResumeLocked(identity, cancelled));
      } catch(error) {
        const errorType = getErrorType(error);
        return errorType ? {kind: 'error', errorType} as const : {kind: 'error'} as const;
      }
    },

    async reauthenticate() {
      let identity: GuestServerIdentity;
      try {
        identity = dependencies.getServerIdentity();
      } catch(error) {
        const errorType = getErrorType(error);
        return errorType ? {kind: 'error', errorType} as const : {kind: 'error'} as const;
      }
      try {
        return await runLocked(identity, async(cancelled) => {
          const accountNumber = dependencies.getCurrentAccountNumber();
          const accountUserId = await dependencies.getAccountUserId(accountNumber);
          const context: GuestAccountContext = {...identity, accountNumber, accountUserId};
          if(!isContextCurrent(context)) return {kind: 'cancelled'} as const;
          const records = await readRecords();
          if(cancelled.value || !isContextCurrent(context)) return {kind: 'cancelled'} as const;
          const record = chooseRecord(records, context);
          if(!record) {
            return accountUserId !== undefined && matchingRecords(records, identity).length ?
              {kind: 'accountInUse'} as const : {kind: 'noGuest'} as const;
          }
          if(accountUserId !== undefined && record.accountUserId !== undefined && !sameUserId(accountUserId, record.accountUserId)) {
            return {kind: 'accountInUse'} as const;
          }

          if(identity.wipeGeneration !== undefined && record.wipeGeneration !== undefined &&
            identity.wipeGeneration !== record.wipeGeneration) {
            cancelled.record = record;
            await clearInvalidatedRecord(record, context, cancelled);
            return {kind: 'wiped'} as const;
          }

          cancelled.record = record;
          let boundUserId = accountUserId;
          const registration: PrivateUsernameRegistration = {
            mode: 'closed',
            displayName: '',
            password: record.password,
            updatePasswordSettings: async() => false,
            checkPassword: async(password) => {
              await assertContext(context, boundUserId, cancelled);
              const user = await dependencies.signInWithPassword(password);
              return user || false;
            },
            onAuthorization: async(user) => {
              await assertContext(context, boundUserId, cancelled);
              const expectedUserId = boundUserId ?? record.accountUserId;
              if(expectedUserId !== undefined && !sameUserId(expectedUserId, user.id as PeerId)) {
                throw Object.assign(new Error('Guest account identity changed'), {type: 'GUEST_ACCOUNT_MISMATCH'});
              }
              await dependencies.setUser(user);
              boundUserId = user.id as PeerId;
              record.accountUserId = boundUserId;
              record.accountNumber = context.accountNumber;
              await assertContext(context, boundUserId, cancelled);
              await saveRecord(record);
            }
          };
          cancelled.registration = registration;
          const result = await authenticatePrivateUsername(
            record.username,
            dependencies.invokeApi,
            () => cancelled.value || !isContextCurrent(context),
            registration,
            dependencies.requestTurnstile,
            dependencies.turnstileSiteKey
          );
          if(result.kind === 'authorized') {
            await assertContext(context, boundUserId, cancelled);
            record.status = 'committed';
            await saveRecord(record);
            return {kind: 'authorized', user: result.user, username: record.username} as const;
          }
          if(result.kind === 'cancelled') return {kind: 'cancelled'} as const;
          if(result.kind === 'invalidCredentials') {
            await clearInvalidatedRecord(record, context, cancelled);
            return {kind: 'unrecoverable', username: record.username} as const;
          }
          if(result.kind === 'usernameTaken' && record.accountUserId !== undefined) {
            await clearInvalidatedRecord(record, context, cancelled);
            return {kind: 'unrecoverable', username: record.username} as const;
          }
          if(result.kind === 'error' && (result.errorType === 'PASSWORD_HASH_INVALID' || result.errorType === 'GUEST_ACCOUNT_MISMATCH')) {
            await clearInvalidatedRecord(record, context, cancelled);
            return {kind: 'unrecoverable', username: record.username} as const;
          }
          if(record.status === 'provisional' && 'errorType' in result && result.errorType === 'INTERNAL') {
            return {kind: 'unrecoverable', username: record.username} as const;
          }
          return resultFromAuthError(result);
        });
      } catch(error) {
        const errorType = getErrorType(error);
        return errorType ? {kind: 'error', errorType} as const : {kind: 'error'} as const;
      }
    },

    async hasWipeGenerationChanged() {
      let identity: GuestServerIdentity;
      try {
        identity = dependencies.getServerIdentity();
      } catch{
        return false;
      }
      try {
        return await runLocked(identity, async(cancelled) => {
          const accountNumber = dependencies.getCurrentAccountNumber();
          const accountUserId = await dependencies.getAccountUserId(accountNumber);
          const context: GuestAccountContext = {...identity, accountNumber, accountUserId};
          if(!isContextCurrent(context)) return false;
          const records = await readRecords();
          if(cancelled.value || !isContextCurrent(context)) return false;
          const record = chooseRecord(records, context);
          if(!record || identity.wipeGeneration === undefined || record.wipeGeneration === undefined ||
            identity.wipeGeneration === record.wipeGeneration) return false;
          return true;
        });
      } catch{
        return false;
      }
    },

    async forget() {
      let identity: GuestServerIdentity;
      try {
        identity = dependencies.getServerIdentity();
      } catch(error) {
        const errorType = getErrorType(error);
        return errorType ? {kind: 'error', errorType} as const : {kind: 'error'} as const;
      }
      try {
        return await runLocked(identity, async(cancelled) => {
          const accountNumber = dependencies.getCurrentAccountNumber();
          const accountUserId = await dependencies.getAccountUserId(accountNumber);
          const context: GuestAccountContext = {...identity, accountNumber, accountUserId};
          if(!isContextCurrent(context)) return {kind: 'cancelled'} as const;
          const records = await readRecords();
          if(cancelled.value || !isContextCurrent(context)) return {kind: 'cancelled'} as const;
          const record = chooseRecord(records, context);
          if(!record) return {kind: 'noGuest'} as const;
          cancelled.record = record;
          const targetAccount = accountUserId !== undefined && sameUserId(accountUserId, record.accountUserId) ?
            context.accountNumber : record.accountUserId === undefined && accountUserId === undefined &&
              record.accountNumber === context.accountNumber ? context.accountNumber : undefined;
          const remaining = records.filter((candidate) => candidate !== record);
          await dependencies.writeCredentials(remaining);
          record.password = '';
          notifyInvalidation(identity.serverId);
          if(dependencies.logOut && targetAccount !== undefined) await dependencies.logOut(targetAccount);
          return {kind: 'forgotten'} as const;
        });
      } catch(error) {
        const errorType = getErrorType(error);
        return errorType ? {kind: 'error', errorType} as const : {kind: 'error'} as const;
      }
    }
  };
}

export function createGuestAccountServerLock<T>(name: string, callback: () => Promise<T>) {
  if(typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.reject(Object.assign(new Error('This browser cannot safely serialize guest account creation'), {
      type: 'GUEST_LOCK_UNAVAILABLE'
    }));
  }
  return navigator.locks.request(name, callback);
}

export type GuestAccountManagers = {
  apiManager: {
    invokeApi: (method: any, params?: any, options?: any) => Promise<any>,
    setUser: (user: User) => Promise<void>,
    logOut: () => Promise<unknown>,
    clearInvalidatedGuestAccount: (accountNumber: ActiveAccountNumber, userId?: PeerId) => Promise<void>
  },
  passwordManager: {
    getState: () => Promise<AccountPassword>,
    getInputCheckPassword: (password: string, state: AccountPassword) => Promise<InputCheckPasswordSRP>,
    updateSettings: (settings: {newPassword?: string}) => Promise<unknown>
  }
};

function getActiveGuestServerIdentity(): GuestServerIdentity {
  const serverId = getRuntimeServerId();
  if(serverId === 'default') {
    const target = getMtprotoTarget();
    return {
      serverId,
      keyFingerprint: target.mode === 'private' ? target.fingerprint : 'telegram-default',
      wipeGeneration: getActiveDemoWipeGeneration()
    };
  }

  if(!/^custom-[0-9a-f]{64}$/.test(serverId)) {
    throw Object.assign(new Error('The selected server identity is invalid'), {type: 'GUEST_SERVER_ID_INVALID'});
  }
  const host = getActiveServerHost();
  const pin = host && getServerPin(host);
  if(!host || !pin || pin.host !== host || !/^[0-9a-f]{64}$/.test(pin.key_fingerprint)) {
    throw Object.assign(new Error('The selected server is not pinned'), {type: 'GUEST_SERVER_NOT_PINNED'});
  }
  return {serverId, keyFingerprint: pin.key_fingerprint, wipeGeneration: getActiveDemoWipeGeneration()};
}

export async function isCurrentAccountGuest() {
  const identity = getActiveGuestServerIdentity();
  const accountNumber = getCurrentAccount();
  const [storedRecords, account] = await Promise.all([
    sessionStorage.get('guestCredentials', false),
    AccountController.get(accountNumber)
  ]);
  const record = chooseRecord(getRecords(storedRecords), {
    ...identity,
    accountNumber,
    accountUserId: account.userId
  });
  return !!record && record.status === 'committed' && record.accountUserId !== undefined &&
    account.userId !== undefined && sameUserId(record.accountUserId, account.userId);
}

export function createCurrentGuestAccountLifecycle(
  managers: GuestAccountManagers,
  options: {
    requestTurnstile?: RequestTurnstileChallenge,
    turnstileSiteKey?: string,
    requestTermsAcceptance?: (terms: HelpTermsOfService) => Promise<boolean>
  } = {}
) {
  const apiManager = managers.apiManager;
  const passwordManager = managers.passwordManager;

  async function getPasswordProof(password: string) {
    const state = await passwordManager.getState();
    return passwordManager.getInputCheckPassword(password, state);
  }

  return createGuestAccountLifecycle({
    getServerIdentity: getActiveGuestServerIdentity,
    isServerIdentityCurrent: (identity) => {
      try {
        const current = getActiveGuestServerIdentity();
        return current.serverId === identity.serverId && current.keyFingerprint === identity.keyFingerprint &&
          current.wipeGeneration === identity.wipeGeneration;
      } catch{
        return false;
      }
    },
    getCurrentAccountNumber: getCurrentAccount,
    getAccountUserId: async(accountNumber) => (await AccountController.get(accountNumber)).userId,
    readCredentials: () => sessionStorage.get('guestCredentials', false),
    writeCredentials: saveGuestCredentials,
    withServerLock: createGuestAccountServerLock,
    invokeApi: (method, params, invokeOptions) => apiManager.invokeApi(method, params, invokeOptions),
    setUser: (user) => apiManager.setUser(user),
    clearInvalidatedAccount: (accountNumber, userId) => apiManager.clearInvalidatedGuestAccount(accountNumber, userId),
    updatePasswordSettings: (password) => passwordManager.updateSettings({newPassword: password}),
    verifyPassword: async(password) => {
      const proof = await getPasswordProof(password);
      try {
        await apiManager.invokeApi('account.getPasswordSettings', {password: proof});
        return true;
      } catch(error) {
        if(getErrorType(error) === 'PASSWORD_HASH_INVALID') return false;
        throw error;
      }
    },
    signInWithPassword: async(password) => {
      const proof = await getPasswordProof(password);
      const authorization = await apiManager.invokeApi('auth.checkPassword', {password: proof});
      return authorization?._ === 'auth.authorization' && authorization.user ? authorization.user : false;
    },
    requestTurnstile: options.requestTurnstile,
    turnstileSiteKey: options.turnstileSiteKey,
    requestTermsAcceptance: options.requestTermsAcceptance,
    logOut: async(accountNumber) => {
      if(getCurrentAccount() !== accountNumber) {
        throw Object.assign(new Error('Select this guest account before forgetting it'), {type: 'GUEST_ACCOUNT_CONTEXT_CHANGED'});
      }
      return apiManager.logOut();
    },
    notifyInvalidation: notifyGuestCredentialInvalidation,
    subscribeInvalidation: listenForGuestCredentialInvalidation
  });
}
