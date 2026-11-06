import type {GuestAccountManagers} from '@lib/guestAccountLifecycle';

export async function loadCurrentGuestAccountLifecycle(managers: GuestAccountManagers) {
  const {createCurrentGuestAccountLifecycle} = await import('@lib/guestAccountLifecycle');
  return createCurrentGuestAccountLifecycle(managers);
}
