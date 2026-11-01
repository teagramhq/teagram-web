import {describe, expect, it, vi} from 'vitest';
import {Register} from '@components/forumTab/register';

describe('lazy register entries', () => {
  it('loads a matching payload only when requested', async() => {
    const payload = {};
    const load = vi.fn(async() => payload);
    const register = new Register<number, typeof payload>();
    register.addEntry({check: (value) => value === 1, load});

    expect(load).not.toHaveBeenCalled();
    await expect(register.getEntryAsync(1)).resolves.toBe(payload);
    await expect(register.getEntryAsync(2)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
