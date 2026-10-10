import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const MAX_ATTEMPTS = 3;
const WINDOW_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 1000;
const STALE_LOCK_MS = 60 * 1000;
const stateDirectory = join(
  tmpdir(),
  `teagram-web-l1-prekey-${typeof process.getuid === 'function' ? process.getuid() : 'shared'}`
);

function isMissing(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT';
}

async function removeStaleLock(lockPath) {
  let lockStats;
  try {
    lockStats = await stat(lockPath);
  } catch(error) {
    if(isMissing(error)) return true;
    throw error;
  }

  if(Date.now() - lockStats.mtimeMs < STALE_LOCK_MS) return false;

  await rm(lockPath, {recursive: true, force: true});
  return true;
}

async function acquireLock(directory) {
  const lockPath = join(directory, 'active.lock');
  for(let attempt = 0; attempt < 2; ++attempt) {
    try {
      await mkdir(lockPath, {mode: 0o700});
      return {
        acquired: true,
        release: () => rm(lockPath, {recursive: true, force: true})
      };
    } catch(error) {
      if(!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
      if(!await removeStaleLock(lockPath)) return {acquired: false};
    }
  }

  return {acquired: false};
}

async function readAttemptState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'attempts,stop_at' ||
      !Array.isArray(parsed.attempts) || !parsed.attempts.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      !(parsed.stop_at === null || Number.isSafeInteger(parsed.stop_at) && parsed.stop_at >= 0)) {
      throw new Error('invalid attempt control state');
    }
    return parsed;
  } catch(error) {
    if(isMissing(error)) return {attempts: [], stop_at: null};
    throw error;
  }
}

export async function acquireAttemptPermit({directory = stateDirectory, now = Date.now()} = {}) {
  if(!Number.isSafeInteger(now) || now < 0) return {allowed: false, reason: 'invalid_input'};
  await mkdir(directory, {recursive: true, mode: 0o700});
  const lock = await acquireLock(directory);
  if(!lock.acquired) return {allowed: false, reason: 'concurrency_limited'};

  let released = false;
  const release = async() => {
    if(released) return;
    released = true;
    await lock.release();
  };

  try {
    const attemptsPath = join(directory, 'attempt-times.json');
    const state = await readAttemptState(attemptsPath);
    const recent = state.attempts.filter((timestamp) => timestamp > now - WINDOW_MS);
    if(Number.isSafeInteger(state.stop_at) && state.stop_at > now - WINDOW_MS) {
      await release();
      return {allowed: false, reason: 'already_stopped'};
    }
    if(recent.length >= MAX_ATTEMPTS) {
      await release();
      return {allowed: false, reason: 'rate_limited'};
    }
    if(recent.length && now - recent[recent.length - 1] < MIN_INTERVAL_MS) {
      await release();
      return {allowed: false, reason: 'interval_limited'};
    }

    await writeFile(attemptsPath, JSON.stringify({attempts: [...recent, now], stop_at: state.stop_at}), {mode: 0o600});
    return {
      allowed: true,
      release,
      markStopped: async() => {
        const current = await readAttemptState(attemptsPath);
        await writeFile(attemptsPath, JSON.stringify({...current, stop_at: now}), {mode: 0o600});
      }
    };
  } catch(error) {
    await release();
    throw error;
  }
}

export const DEFAULT_ATTEMPT_CONTROL_DIRECTORY = stateDirectory;
