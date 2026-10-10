import {mkdtemp, mkdir, readFile, rm, utimes, writeFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {createConnection, createServer} from 'node:net';
import type {Server, Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {acquireAttemptPermit} from './l1PrekeyRunnerPolicy.mjs';

const temporaryDirectories: string[] = [];
const ownerServers: Server[] = [];

async function createPolicyDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'teagram-l1-policy-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async() => {
  await Promise.all(ownerServers.splice(0).map((server) => new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

function ownerIsReachable(socketPath: string) {
  return new Promise<boolean>(resolvePromise => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

function createOwnerProbeSocket() {
  const socket = new EventEmitter() as EventEmitter & {destroy: () => void};
  socket.destroy = () => {};
  return socket;
}

function createOwnerProbeErrorConnection(code: string) {
  return () => {
    const socket = createOwnerProbeSocket();
    queueMicrotask(() => socket.emit('error', Object.assign(new Error('probe failed'), {code})));
    return socket as unknown as Pick<Socket, 'once'|'destroy'>;
  };
}

describe('L1 pre-key runner limits', () => {
  it('allows no more than three attempts in ten minutes and spaces them by five seconds', async() => {
    const directory = await createPolicyDirectory();
    const first = await acquireAttemptPermit({directory, now: 1_000_000});
    expect(first).toMatchObject({allowed: true});
    await first.release();

    const tooSoon = await acquireAttemptPermit({directory, now: 1_004_999});
    expect(tooSoon).toMatchObject({allowed: false, reason: 'interval_limited'});

    const second = await acquireAttemptPermit({directory, now: 1_005_000});
    expect(second).toMatchObject({allowed: true});
    await second.release();

    const third = await acquireAttemptPermit({directory, now: 1_010_000});
    expect(third).toMatchObject({allowed: true});
    await third.release();

    const fourth = await acquireAttemptPermit({directory, now: 1_015_000});
    expect(fourth).toMatchObject({allowed: false, reason: 'rate_limited'});

    const afterWindow = await acquireAttemptPermit({directory, now: 1_610_000});
    expect(afterWindow).toMatchObject({allowed: true});
    await afterWindow.release();
  });

  it('rejects concurrent attempts and stores only timestamps for rate enforcement', async() => {
    const directory = await createPolicyDirectory();
    const active = await acquireAttemptPermit({directory, now: 2_000_000});
    expect(active).toMatchObject({allowed: true});

    const concurrent = await acquireAttemptPermit({directory, now: 2_005_000});
    expect(concurrent).toMatchObject({allowed: false, reason: 'concurrency_limited'});

    await active.release();
    const state = await readFile(join(directory, 'attempt-times.json'), 'utf8');
    expect(JSON.parse(state)).toEqual({attempts: [2_000_000], stop_at: null});
    expect(state).not.toMatch(/endpoint|fingerprint|nonce|key|source_ref/i);
  });

  it('does not reclaim a live owner just because its lock directory looks old', async() => {
    const directory = await createPolicyDirectory();
    const active = await acquireAttemptPermit({directory, now: 2_500_000});
    const lockPath = join(directory, 'active.lock');
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(lockPath, old, old);

    const concurrent = await acquireAttemptPermit({directory, now: 2_505_000});
    expect(concurrent).toMatchObject({allowed: false, reason: 'concurrency_limited'});
    await active.release();
  });

  it('keeps a replacement active owner when it appears during stale-lock reclamation', async() => {
    const directory = await createPolicyDirectory();
    const lockPath = join(directory, 'active.lock');
    await mkdir(lockPath);
    await writeFile(join(lockPath, 'owner.lock'), '');
    await writeFile(join(lockPath, 'owner.sock'), 'stale socket marker');
    const result = await acquireAttemptPermit({
      directory,
      now: 2_750_000,
      testHooks: {
        createOwnerConnection: createOwnerProbeErrorConnection('ECONNREFUSED'),
        afterUnownedLockObserved: async(observedLockPath: string) => {
          if(observedLockPath !== lockPath) return;
          await rm(lockPath, {recursive: true, force: true});
          await mkdir(lockPath);
          await writeFile(join(lockPath, 'owner.lock'), '');
          const replacementOwnerServer = createServer(socket => socket.end());
          ownerServers.push(replacementOwnerServer);
          await new Promise<void>((resolvePromise, rejectPromise) => {
            replacementOwnerServer.once('error', rejectPromise);
            replacementOwnerServer.listen(join(lockPath, 'owner.sock'), resolvePromise);
          });
        }
      }
    });

    expect(result).toMatchObject({allowed: false, reason: 'concurrency_limited'});
    await expect(ownerIsReachable(join(lockPath, 'owner.sock'))).resolves.toBe(true);
  });

  it('fails closed when the owner socket probe times out', async() => {
    const directory = await createPolicyDirectory();
    const lockPath = join(directory, 'active.lock');
    await mkdir(lockPath);
    await writeFile(join(lockPath, 'owner.lock'), '');
    await writeFile(join(lockPath, 'owner.sock'), 'owner socket marker');
    let probeCount = 0;

    const result = await acquireAttemptPermit({
      directory,
      now: 2_800_000,
      testHooks: {
        createOwnerConnection: () => {
          probeCount++;
          return createOwnerProbeSocket() as unknown as Pick<Socket, 'once'|'destroy'>;
        }
      }
    });

    expect(result).toMatchObject({allowed: false, reason: 'concurrency_limited'});
    expect(probeCount).toBe(1);
    await expect(readFile(join(lockPath, 'owner.lock'), 'utf8')).resolves.toBe('');
  });

  it.each(['ECONNRESET', 'ETIMEDOUT'])('fails closed on an inconclusive owner socket error (%s)', async(code) => {
    const directory = await createPolicyDirectory();
    const lockPath = join(directory, 'active.lock');
    await mkdir(lockPath);
    await writeFile(join(lockPath, 'owner.lock'), '');
    await writeFile(join(lockPath, 'owner.sock'), 'owner socket marker');

    const result = await acquireAttemptPermit({
      directory,
      now: 2_900_000,
      testHooks: {createOwnerConnection: createOwnerProbeErrorConnection(code)}
    });

    expect(result).toMatchObject({allowed: false, reason: 'concurrency_limited'});
    await expect(readFile(join(lockPath, 'owner.lock'), 'utf8')).resolves.toBe('');
  });

  it('blocks further attempts in the window after a valid DH inner reply', async() => {
    const directory = await createPolicyDirectory();
    const successfulAttempt = await acquireAttemptPermit({directory, now: 3_000_000});
    expect(successfulAttempt).toMatchObject({allowed: true});
    await successfulAttempt.markStopped();
    await successfulAttempt.release();

    const blocked = await acquireAttemptPermit({directory, now: 3_005_000});
    expect(blocked).toMatchObject({allowed: false, reason: 'already_stopped'});
  });
});
