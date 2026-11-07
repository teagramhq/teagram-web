import type {GuestAccountContext, GuestCredentialRecord, GuestCredentialRecords, GuestServerIdentity} from '@lib/guestAccountTypes';

const GUEST_USERNAME_PATTERN = /^guest_[a-z2-7]{16}$/;
const GUEST_PASSWORD_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function sameGuestUserId(left?: PeerId, right?: PeerId) {
  return left === undefined ? right === undefined : right !== undefined && String(left) === String(right);
}

function isGuestCredentialRecord(value: unknown): value is GuestCredentialRecord {
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

export function getGuestCredentialRecords(value: unknown): GuestCredentialRecords {
  if(value === undefined) return [];
  if(!Array.isArray(value) || !value.every(isGuestCredentialRecord)) {
    throw Object.assign(new Error('Guest credential storage is invalid'), {type: 'GUEST_CREDENTIAL_STORAGE_INVALID'});
  }
  return value;
}

export function matchingGuestRecords(records: GuestCredentialRecords, identity: GuestServerIdentity) {
  return records.filter((record) => record.serverId === identity.serverId && record.keyFingerprint === identity.keyFingerprint);
}

export function chooseGuestCredentialRecord(records: GuestCredentialRecords, context: GuestAccountContext) {
  const scoped = matchingGuestRecords(records, context);
  if(context.accountUserId !== undefined) {
    const accountRecord = scoped.find((record) => sameGuestUserId(record.accountUserId, context.accountUserId));
    if(accountRecord) return accountRecord;
    return undefined;
  }
  return scoped.find((record) => record.accountNumber === context.accountNumber) || (scoped.length === 1 ? scoped[0] : undefined);
}
