import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {GuestCredentialRecord} from '@lib/guestAccountTypes';

const mocks = vi.hoisted(() => ({
  records: [] as any[],
  get: vi.fn(async() => mocks.records),
  set: vi.fn(async({guestCredentials}: {guestCredentials: any[]}) => { mocks.records = guestCredentials; }),
  delete: vi.fn(async() => { mocks.records = []; }),
  flush: vi.fn(async() => {}),
  notify: vi.fn()
}));

vi.mock('@lib/sessionStorage', () => ({default: {get: mocks.get, set: mocks.set, delete: mocks.delete, flush: mocks.flush}}));
vi.mock('@lib/guestCredentialBroadcast', () => ({notifyGuestCredentialInvalidation: mocks.notify}));

import {clearAllGuestCredentials, clearGuestCredentialsForAccount, saveGuestCredentials} from '@lib/guestCredentialStorage';

const guest = (username: string, accountUserId?: number, accountNumber?: 1 | 2 | 3 | 4): GuestCredentialRecord => ({
  version: 1,
  serverId: 'custom-server-a',
  keyFingerprint: 'pinned-key-a',
  username,
  password: 'P'.repeat(43),
  status: accountUserId ? 'committed' : 'provisional',
  accountUserId,
  accountNumber
});

beforeEach(() => {
  mocks.records = [];
  vi.clearAllMocks();
});

describe('guest credential cleanup', () => {
  it('finds the guest by account ID after its account slot shifts', async() => {
    mocks.records = [guest('guest_a', 42, 1), guest('guest_b', 44, 2)];

    await clearGuestCredentialsForAccount(42, 2);

    expect(mocks.records).toEqual([guest('guest_b', 44, 2)]);
    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('clears an unbound provisional credential when its account slot is logged out', async() => {
    mocks.records = [guest('guest_a', undefined, 2), guest('guest_b', 44, 1)];

    await clearGuestCredentialsForAccount(undefined, 2);

    expect(mocks.records).toEqual([guest('guest_b', 44, 1)]);
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('clears every guest secret on force logout and notifies tabs for that server', async() => {
    mocks.records = [guest('guest_a', 42, 1)];

    await clearAllGuestCredentials('custom-server-a');

    expect(mocks.delete).toHaveBeenCalledWith('guestCredentials');
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.records).toEqual([]);
    expect(mocks.notify).toHaveBeenCalledWith('custom-server-a');
  });

  it('does not resolve credential writes before the durable storage flush completes', async() => {
    let finishFlush!: () => void;
    mocks.flush.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    let saved = false;

    const saving = saveGuestCredentials([guest('guest_saved')]).then(() => { saved = true; });
    await Promise.resolve();

    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(saved).toBe(false);

    finishFlush();
    await saving;
    expect(saved).toBe(true);
  });
});
