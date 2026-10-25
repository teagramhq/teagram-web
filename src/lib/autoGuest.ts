import {scopeServerStorageKey} from '@config/serverContext';

const AUTO_GUEST_ATTEMPTED_KEY = 'teagram.auto-guest-attempted.v1';

function storageKey() {
  return scopeServerStorageKey(AUTO_GUEST_ATTEMPTED_KEY);
}

export function hasAutoGuestAttempted() {
  try {
    return localStorage.getItem(storageKey()) !== null;
  } catch{
    return true;
  }
}

export function markAutoGuestAttempted() {
  try {
    localStorage.setItem(storageKey(), '1');
    return true;
  } catch{
    return false;
  }
}
