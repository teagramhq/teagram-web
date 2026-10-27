import {scopeServerStorageKey} from '@config/serverContext';

const AUTO_GUEST_ATTEMPTED_KEY = 'teagram.auto-guest-attempted.v1';
const AUTO_GUEST_RESET_NOTICE_KEY = 'teagram.auto-guest-reset-notice.v1';

function storageKey() {
  return scopeServerStorageKey(AUTO_GUEST_ATTEMPTED_KEY);
}

function resetNoticeStorageKey() {
  return scopeServerStorageKey(AUTO_GUEST_RESET_NOTICE_KEY);
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

export function markAutoGuestResetDetected() {
  try {
    localStorage.setItem(resetNoticeStorageKey(), '1');
    localStorage.removeItem(storageKey());
    return true;
  } catch{
    return false;
  }
}

export function hasAutoGuestResetNotice() {
  try {
    return localStorage.getItem(resetNoticeStorageKey()) === '1';
  } catch{
    return false;
  }
}

export function clearAutoGuestResetNotice() {
  try {
    localStorage.removeItem(resetNoticeStorageKey());
  } catch{}
}
