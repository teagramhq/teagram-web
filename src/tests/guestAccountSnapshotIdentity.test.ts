import {expect, it, vi} from 'vitest';
import {hasGuestWipeGenerationChanged, isGuestSnapshotIdentityCurrent} from '@lib/guestAccountSnapshotIdentity';

const identity = {serverId: 'server-id', keyFingerprint: 'fingerprint', wipeGeneration: 'generation-1'};

const committedRecord = {
  version: 1 as const,
  serverId: identity.serverId,
  keyFingerprint: identity.keyFingerprint,
  username: 'guest_abcdefghijklmnop',
  password: 'A'.repeat(43),
  status: 'committed' as const,
  wipeGeneration: identity.wipeGeneration,
  accountUserId: '123',
  accountNumber: 1 as const
};

function makeDependencies(overrides: Record<string, unknown> = {}) {
  let accountNumber = 1;
  const cancelled = {value: false};
  const dependencies = {
    getCurrentAccountNumber: () => accountNumber,
    getAccountUserId: vi.fn(async() => '123'),
    readRecords: vi.fn(async() => [committedRecord]),
    isContextCurrent: vi.fn((context: {accountNumber: number}) => context.accountNumber === accountNumber),
    ...overrides
  };
  return {
    dependencies,
    cancelled,
    setAccountNumber(value: number) { accountNumber = value; }
  };
}

it('accepts only a committed record for the current account, server and wipe generation', async() => {
  const {dependencies, cancelled} = makeDependencies();

  await expect(isGuestSnapshotIdentityCurrent(identity, cancelled, dependencies as any)).resolves.toBe(true);
});

it.each([
  ['provisional record', {...committedRecord, status: 'provisional'}],
  ['missing record user id', {...committedRecord, accountUserId: undefined}],
  ['wrong wipe generation', {...committedRecord, wipeGeneration: 'generation-2'}]
])('rejects a %s', async(_label, record) => {
  const {dependencies, cancelled} = makeDependencies({readRecords: vi.fn(async() => [record])});

  await expect(isGuestSnapshotIdentityCurrent(identity, cancelled, dependencies as any)).resolves.toBe(false);
});

it('rejects an account with no confirmed user id', async() => {
  const {dependencies, cancelled} = makeDependencies({getAccountUserId: vi.fn(async() => undefined)});

  await expect(isGuestSnapshotIdentityCurrent(identity, cancelled, dependencies as any)).resolves.toBe(false);
});

it('rejects cancellation and account changes during credential reads', async() => {
  const {dependencies, cancelled, setAccountNumber} = makeDependencies({
    readRecords: vi.fn(async() => {
      setAccountNumber(2);
      return [committedRecord];
    })
  });

  await expect(isGuestSnapshotIdentityCurrent(identity, cancelled, dependencies as any)).resolves.toBe(false);

  setAccountNumber(1);
  dependencies.readRecords.mockImplementation(async() => {
    cancelled.value = true;
    return [committedRecord];
  });
  await expect(isGuestSnapshotIdentityCurrent(identity, cancelled, dependencies as any)).resolves.toBe(false);
});

it('detects only a guest wipe generation change for the current identity', async() => {
  const {dependencies, cancelled} = makeDependencies({
    readRecords: vi.fn(async() => [{...committedRecord, wipeGeneration: 'generation-0'}])
  });
  await expect(hasGuestWipeGenerationChanged(identity, cancelled, dependencies as any)).resolves.toBe(true);

  dependencies.readRecords.mockResolvedValue([committedRecord]);
  await expect(hasGuestWipeGenerationChanged(identity, cancelled, dependencies as any)).resolves.toBe(false);
});
