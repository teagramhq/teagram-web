import {expect, it, vi} from 'vitest';

const lifecycleModule = vi.hoisted(() => ({loaded: false}));

vi.mock('@lib/guestAccountLifecycle', () => {
  lifecycleModule.loaded = true;
  return {
    createCurrentGuestAccountLifecycle: (managers: unknown) => ({managers})
  };
});

import {loadCurrentGuestAccountLifecycle} from '@lib/loadCurrentGuestAccountLifecycle';

it('loads the guest lifecycle only when an auto-guest path needs it', async() => {
  expect(lifecycleModule.loaded).toBe(false);
  const managers = {};

  await expect(loadCurrentGuestAccountLifecycle(managers as any)).resolves.toEqual({managers});
  expect(lifecycleModule.loaded).toBe(true);
});
