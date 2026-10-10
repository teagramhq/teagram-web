import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {acquireAttemptPermit} from './l1PrekeyRunnerPolicy.mjs';

const temporaryDirectories: string[] = [];

async function createPolicyDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'teagram-l1-policy-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async() => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

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
