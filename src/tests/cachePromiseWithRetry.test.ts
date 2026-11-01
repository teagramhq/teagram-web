import {describe, expect, it, vi} from 'vitest';
import cachePromiseWithRetry from '@helpers/cachePromiseWithRetry';

describe('cachePromiseWithRetry', () => {
  it('reuses an in-flight promise and retries after rejection', async() => {
    let cached: Promise<string>;
    let attempts = 0;
    const load = vi.fn(() => {
      ++attempts;
      return attempts === 1 ? Promise.reject(new Error('chunk failed')) : Promise.resolve('ready');
    });
    const get = () => cached;
    const set = (promise: Promise<string>) => cached = promise;
    const start = () => cachePromiseWithRetry(get, set, load);

    const first = start();
    expect(start()).toBe(first);
    await expect(first).rejects.toThrow('chunk failed');
    expect(cached).toBeUndefined();

    const retry = start();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toBe('ready');
    expect(start()).toBe(retry);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
