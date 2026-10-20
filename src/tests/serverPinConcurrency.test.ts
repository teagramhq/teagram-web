import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  SERVER_PINS_KEY,
  writeServerPin
} from '@config/serverSelection';
import type {DiscoveredServer} from '@config/serverSelection';

const HOST = 'chat.example.org';

function discovered(fingerprint: string): DiscoveredServer {
  const pin = {
    host: HOST,
    endpoint: 'wss://chat.example.org/apiws',
    dc_id: 2,
    key_fingerprint: fingerprint
  };
  return {
    host: HOST,
    id: 'custom-' + 'a'.repeat(64),
    target: {mode: 'private'} as any,
    pin,
    spkiFingerprint: fingerprint
  };
}

function serializedLocks() {
  let tail = Promise.resolve();
  return {
    request: vi.fn(async(name: string, callback: (lock: Lock) => Promise<void>) => {
      const previous = tail;
      let release: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback({name, mode: 'exclusive'} as Lock);
      } finally {
        release();
      }
    })
  } as unknown as LockManager;
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('custom server pin writes', () => {
  it('serializes first-use confirmations and refuses the stale key', async() => {
    const locks = serializedLocks();
    vi.stubGlobal('navigator', {locks});
    const first = discovered('a'.repeat(64));
    const stale = discovered('b'.repeat(64));

    const results = await Promise.allSettled([
      writeServerPin(first),
      writeServerPin(stale)
    ]);

    expect(locks.request).toHaveBeenCalledTimes(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(SERVER_PINS_KEY) || '{}')[HOST].key_fingerprint)
      .toBe(first.pin.key_fingerprint);
  });

  it('fails closed when cross-tab pin locks are unavailable', async() => {
    vi.stubGlobal('navigator', {});

    await expect(writeServerPin(discovered('a'.repeat(64)))).rejects.toThrow(/safely confirm this server/i);
    expect(localStorage.getItem(SERVER_PINS_KEY)).toBeNull();
  });
});
