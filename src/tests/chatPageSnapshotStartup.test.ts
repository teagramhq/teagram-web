import {expect, it, vi} from 'vitest';
import * as startup from '@lib/chatPageSnapshotStartup';

const key = {accountNumber: 1 as const, userId: 123 as PeerId, server: 'server', authKeyId: 'key'};
const rows = [{peerId: 42 as PeerId, title: 'Alice', preview: 'Hello', date: 1, unread: 0, markedUnread: false, muted: false, pinned: false}];
const runGuestSnapshot = (startup as any).paintGuestChatPageSnapshotIfCurrent as (dependencies: any) => Promise<void>;

function makeDependencies(overrides: Record<string, unknown> = {}) {
  let wipeGeneration = 'generation-1';
  const dependencies = {
    accountNumber: 1,
    serverHost: 'server.example.test',
    serverId: 'server-id',
    wipeGeneration: 'generation-1',
    isSnapshotIdentityCurrent: vi.fn(async() => true),
    getChatPageKey: vi.fn(async() => key),
    getCurrentAccountNumber: () => 1,
    getActiveServerHost: () => 'server.example.test',
    getRuntimeServerId: () => 'server-id',
    getActiveDemoWipeGeneration: () => wipeGeneration,
    readSnapshot: vi.fn(() => rows),
    paint: vi.fn(),
    clear: vi.fn(),
    ...overrides
  };
  return {
    dependencies,
    setWipeGeneration(value: string) { wipeGeneration = value; }
  };
}

it('requires a confirmed current guest identity before reading or painting', async() => {
  expect(runGuestSnapshot).toBeTypeOf('function');
  const {dependencies} = makeDependencies({isSnapshotIdentityCurrent: vi.fn(async() => false)});

  await runGuestSnapshot(dependencies);

  expect(dependencies.getChatPageKey).not.toHaveBeenCalled();
  expect(dependencies.readSnapshot).not.toHaveBeenCalled();
  expect(dependencies.paint).not.toHaveBeenCalled();
});

it('does not paint when the wipe generation changes while the account key loads', async() => {
  expect(runGuestSnapshot).toBeTypeOf('function');
  let finishKey!: (value: typeof key) => void;
  const {dependencies, setWipeGeneration} = makeDependencies({
    getChatPageKey: vi.fn(() => new Promise<typeof key>((resolve) => { finishKey = resolve; }))
  });
  const pending = runGuestSnapshot(dependencies);
  await vi.waitFor(() => expect(dependencies.getChatPageKey).toHaveBeenCalledOnce());
  setWipeGeneration('generation-2');
  finishKey(key);
  await pending;

  expect(dependencies.paint).not.toHaveBeenCalled();
});

it('logs paint failures and removes the incomplete snapshot view', async() => {
  expect(runGuestSnapshot).toBeTypeOf('function');
  const {dependencies} = makeDependencies({paint: vi.fn(() => { throw new Error('invalid row'); })});
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});

  await runGuestSnapshot(dependencies);

  expect(log).toHaveBeenCalledWith('Could not paint the chat page snapshot', expect.any(Error));
  expect(dependencies.clear).toHaveBeenCalledOnce();
});
