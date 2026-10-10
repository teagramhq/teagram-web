import {createConnection, createServer} from 'node:net';
import {open, lstat, mkdir, readFile, rm, rmdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const MAX_ATTEMPTS = 3;
const WINDOW_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 1000;
const ACTIVE_LOCK_NAME = 'active.lock';
const MAINTENANCE_LOCK_NAME = 'maintenance.lock';
const OWNER_MARKER_NAME = 'owner.lock';
const OWNER_SOCKET_NAME = 'owner.sock';
const MAINTENANCE_RELEASE_RETRIES = 100;
const stateDirectory = join(
  tmpdir(),
  `teagram-web-l1-prekey-${typeof process.getuid === 'function' ? process.getuid() : 'shared'}`
);

/** @typedef {Pick<import('node:net').Socket, 'once'|'destroy'>} OwnerProbeSocket */
/** @typedef {{afterUnownedLockObserved?: (lockPath: string) => Promise<void>, createOwnerConnection?: (socketPath: string) => OwnerProbeSocket}} PolicyTestHooks */
/** @typedef {{directory?: string, now?: number, testHooks?: PolicyTestHooks}} AcquireAttemptOptions */

function isMissing(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT';
}

function isAlreadyExists(error) {
  return error && typeof error === 'object' && error.code === 'EEXIST';
}

function sameDirectory(first, second) {
  return first && second && first.dev === second.dev && first.ino === second.ino;
}

function sameFile(first, second) {
  return first && second && first.dev === second.dev && first.ino === second.ino;
}

async function getDirectoryIdentity(path) {
  try {
    const current = await lstat(path);
    return current.isDirectory() ? current : undefined;
  } catch(error) {
    if(isMissing(error)) return undefined;
    throw error;
  }
}

async function getOwnerMarkerIdentity(path) {
  try {
    const current = await lstat(path);
    return current.isFile() && current.size === 0 ? current : undefined;
  } catch(error) {
    if(isMissing(error)) return undefined;
    throw error;
  }
}

async function ownerSocketExists(path) {
  try {
    const current = await lstat(path);
    return current.isSocket() || current.isFile();
  } catch(error) {
    if(isMissing(error)) return false;
    throw error;
  }
}

/** @param {string} socketPath @param {(socketPath: string) => OwnerProbeSocket} [createSocket] */
function probeOwnerSocket(socketPath, createSocket = createConnection) {
  return new Promise(resolvePromise => {
    let socket;
    let settled = false;
    const timeout = setTimeout(() => finish('unknown'), 100);
    const finish = result => {
      if(settled) return;
      settled = true;
      clearTimeout(timeout);
      socket?.destroy();
      resolvePromise(result);
    };

    try {
      socket = createSocket(socketPath);
    } catch{
      finish('unknown');
      return;
    }
    socket.once('connect', () => finish('reachable'));
    socket.once('error', error => {
      const code = error && typeof error === 'object' ? error.code : undefined;
      finish(code === 'ECONNREFUSED' ? 'stale' : 'unknown');
    });
  });
}

async function makeOwnerServer(socketPath) {
  const server = createServer(socket => socket.end());
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = error => rejectPromise(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.removeListener('error', onError);
      resolvePromise();
    });
  });
  return server;
}

async function closeOwnerServer(server) {
  if(!server.listening) return;
  await new Promise(resolvePromise => server.close(() => resolvePromise()));
}

async function tryAcquireMaintenanceLock(directory) {
  const path = join(directory, MAINTENANCE_LOCK_NAME);
  try {
    await mkdir(path, {mode: 0o700});
  } catch(error) {
    if(isAlreadyExists(error)) return undefined;
    throw error;
  }

  return {
    release: () => rmdir(path)
  };
}

async function waitForMaintenanceLock(directory) {
  for(let attempt = 0; attempt < MAINTENANCE_RELEASE_RETRIES; ++attempt) {
    const lock = await tryAcquireMaintenanceLock(directory);
    if(lock) return lock;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  }
  return undefined;
}

async function removeUnownedLock(lockPath, identity, testHooks) {
  const ownerSocket = join(lockPath, OWNER_SOCKET_NAME);
  const ownerMarkerPath = join(lockPath, OWNER_MARKER_NAME);
  const createOwnerConnection = testHooks?.createOwnerConnection;
  let ownerHandle;
  try {
    ownerHandle = await open(ownerMarkerPath, 'r');
  } catch(error) {
    if(isMissing(error)) return false;
    throw error;
  }

  try {
    const ownerIdentity = await ownerHandle.stat();
    if(!ownerIdentity.isFile() || ownerIdentity.size !== 0 ||
      !await ownerSocketExists(ownerSocket) ||
      await probeOwnerSocket(ownerSocket, createOwnerConnection) !== 'stale') return false;
    if(typeof testHooks?.afterUnownedLockObserved === 'function') {
      await testHooks.afterUnownedLockObserved(lockPath);
    }

    const current = await getDirectoryIdentity(lockPath);
    const currentOwner = await getOwnerMarkerIdentity(ownerMarkerPath);
    if(!sameDirectory(identity, current) || !sameFile(ownerIdentity, currentOwner)) return false;
    if(!await ownerSocketExists(ownerSocket) ||
      await probeOwnerSocket(ownerSocket, createOwnerConnection) !== 'stale') return false;

    const latest = await getDirectoryIdentity(lockPath);
    const latestOwner = await getOwnerMarkerIdentity(ownerMarkerPath);
    if(!sameDirectory(identity, latest) || !sameFile(ownerIdentity, latestOwner) ||
      await probeOwnerSocket(ownerSocket, createOwnerConnection) !== 'stale') return false;

    await ownerHandle.close();
    ownerHandle = undefined;
    await rm(lockPath, {recursive: true, force: false});
    return true;
  } finally {
    await ownerHandle?.close();
  }
}

async function releaseActiveLock(directory, lockPath, identity, ownerIdentity, ownerHandle, ownerServer) {
  const maintenanceLock = await waitForMaintenanceLock(directory);
  if(!maintenanceLock) {
    await ownerHandle.close();
    ownerServer.unref();
    return;
  }

  try {
    const current = await getDirectoryIdentity(lockPath);
    const currentOwner = await getOwnerMarkerIdentity(join(lockPath, OWNER_MARKER_NAME));
    await closeOwnerServer(ownerServer);
    if(sameDirectory(identity, current) && sameFile(ownerIdentity, currentOwner)) {
      await ownerHandle.close();
      await rm(lockPath, {recursive: true, force: false});
    } else {
      await ownerHandle.close();
    }
  } finally {
    await maintenanceLock.release();
  }
}

async function acquireLock(directory, testHooks) {
  const maintenanceLock = await tryAcquireMaintenanceLock(directory);
  if(!maintenanceLock) return {acquired: false};

  let releasedMaintenanceLock = false;
  const releaseMaintenanceLock = async() => {
    if(releasedMaintenanceLock) return;
    releasedMaintenanceLock = true;
    await maintenanceLock.release();
  };

  try {
    const lockPath = join(directory, ACTIVE_LOCK_NAME);
    for(let attempt = 0; attempt < 2; ++attempt) {
      try {
        await mkdir(lockPath, {mode: 0o700});
      } catch(error) {
        if(!isAlreadyExists(error)) throw error;
        const identity = await getDirectoryIdentity(lockPath);
        if(!identity) return {acquired: false};
        if(!await removeUnownedLock(lockPath, identity, testHooks)) return {acquired: false};
        continue;
      }

      const identity = await getDirectoryIdentity(lockPath);
      if(!identity) return {acquired: false};
      let ownerHandle;
      try {
        ownerHandle = await open(join(lockPath, OWNER_MARKER_NAME), 'wx', 0o600);
      } catch(error) {
        const current = await getDirectoryIdentity(lockPath);
        if(sameDirectory(identity, current)) await rm(lockPath, {recursive: true, force: true});
        throw error;
      }
      let ownerIdentity;
      try {
        ownerIdentity = await ownerHandle.stat();
      } catch(error) {
        await ownerHandle.close();
        const current = await getDirectoryIdentity(lockPath);
        if(sameDirectory(identity, current)) await rm(lockPath, {recursive: true, force: true});
        throw error;
      }
      let ownerServer;
      try {
        ownerServer = await makeOwnerServer(join(lockPath, OWNER_SOCKET_NAME));
      } catch(error) {
        const current = await getDirectoryIdentity(lockPath);
        await ownerHandle.close();
        if(sameDirectory(identity, current)) await rm(lockPath, {recursive: true, force: true});
        throw error;
      }

      const current = await getDirectoryIdentity(lockPath);
      if(!sameDirectory(identity, current)) {
        await closeOwnerServer(ownerServer);
        await ownerHandle.close();
        return {acquired: false};
      }

      await releaseMaintenanceLock();
      return {
        acquired: true,
        release: () => releaseActiveLock(directory, lockPath, identity, ownerIdentity, ownerHandle, ownerServer)
      };
    }

    return {acquired: false};
  } finally {
    await releaseMaintenanceLock();
  }
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

/** @param {AcquireAttemptOptions} [options] */
export async function acquireAttemptPermit({directory = stateDirectory, now = Date.now(), testHooks} = {}) {
  if(!Number.isSafeInteger(now) || now < 0) return {allowed: false, reason: 'invalid_input'};
  await mkdir(directory, {recursive: true, mode: 0o700});
  const lock = await acquireLock(directory, testHooks);
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
