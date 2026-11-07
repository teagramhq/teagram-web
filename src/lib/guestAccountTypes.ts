import type {ActiveAccountNumber} from '@lib/accounts/types';

export type GuestServerIdentity = {
  serverId: string,
  keyFingerprint: string,
  wipeGeneration?: string
};

export type GuestAccountContext = GuestServerIdentity & {
  accountNumber: ActiveAccountNumber,
  accountUserId?: PeerId
};

export type GuestCredentialRecord = {
  version: 1,
  serverId: string,
  keyFingerprint: string,
  username: string,
  password: string,
  status: 'provisional' | 'committed',
  wipeGeneration?: string,
  accountUserId?: PeerId,
  accountNumber?: ActiveAccountNumber
};

export type GuestCredentialRecords = GuestCredentialRecord[];
