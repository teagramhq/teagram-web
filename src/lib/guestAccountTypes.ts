import type {ActiveAccountNumber} from '@lib/accounts/types';

export type GuestCredentialRecord = {
  version: 1,
  serverId: string,
  keyFingerprint: string,
  username: string,
  password: string,
  status: 'provisional' | 'committed',
  accountUserId?: PeerId,
  accountNumber?: ActiveAccountNumber
};

export type GuestCredentialRecords = GuestCredentialRecord[];
