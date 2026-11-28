const INVITE_SECRET_PATTERN = /^[\da-f]{64}$/i;
const INVITE_SECRET_SESSION_KEY = 'teagram-invite-secret';
const FRAGMENT_LINK_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

let inviteSecretFromFragment: string | undefined;
let v1InviteSecretFromFragment: string | undefined;

function fragmentLinkType(fragment: string) {
  if(!fragment.startsWith('#~')) return;
  const encoded = fragment.slice(2);
  if(encoded.length < 2) return;

  const high = FRAGMENT_LINK_ALPHABET.indexOf(encoded[0]);
  const low = FRAGMENT_LINK_ALPHABET.indexOf(encoded[1]);
  if(high < 0 || low < 0) return;
  return ((high << 2) | (low >> 4)) & 0x1f;
}

function decodeV1InviteSecret(fragment: string) {
  const encoded = fragment.slice(2);
  if(!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return;

  let binary: string;
  try {
    const standard = encoded.replace(/-/g, '+').replace(/_/g, '/');
    binary = atob(standard + '='.repeat((4 - standard.length % 4) % 4));
  } catch{
    return;
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const canonical = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if(canonical !== encoded || bytes.length !== 33) return;

  const header = bytes[0];
  if((header >> 6) !== 1 || (header & 0x1f) !== 5 || (header & 0x20) !== 0) return;
  return Array.from(bytes.slice(1), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function clearFragment() {
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`
  );
}

export function parsePrivateUsernameInviteSecret(value: string): string | undefined {
  const trimmed = value.trim();
  const fragmentIndex = trimmed.lastIndexOf('#');
  const candidate = fragmentIndex === -1 ? trimmed : trimmed.slice(fragmentIndex + 1);
  if(!INVITE_SECRET_PATTERN.test(candidate)) return;
  return candidate.toLowerCase();
}

export function capturePrivateUsernameInviteSecretFromFragment() {
  const fragment = window.location.hash;
  const secret = fragment.slice(1);
  if(INVITE_SECRET_PATTERN.test(secret)) {
    inviteSecretFromFragment = secret.toLowerCase();
    clearFragment();
    return;
  }

  if(fragmentLinkType(fragment) !== 5) return;
  clearFragment();
  v1InviteSecretFromFragment = decodeV1InviteSecret(fragment);
}

export function takePrivateUsernameInviteSecretFromFragment() {
  let secret = inviteSecretFromFragment;
  inviteSecretFromFragment = undefined;

  if(typeof window !== 'undefined') {
    try {
      if(!secret) secret = window.sessionStorage.getItem(INVITE_SECRET_SESSION_KEY) || undefined;
      window.sessionStorage.removeItem(INVITE_SECRET_SESSION_KEY);
    } catch(err) {}
  }

  if(secret && !INVITE_SECRET_PATTERN.test(secret)) return;
  return secret;
}

export function takePrivateUsernameV1InviteSecretFromFragment() {
  const inviteValue = v1InviteSecretFromFragment;
  v1InviteSecretFromFragment = undefined;
  return inviteValue;
}

export function restorePrivateUsernameV1InviteSecretForRetry(secret: string) {
  if(!INVITE_SECRET_PATTERN.test(secret)) return false;
  v1InviteSecretFromFragment = secret.toLowerCase();
  return true;
}

export function storePrivateUsernameInviteSecretForAccountSwitch(secret: string) {
  if(!INVITE_SECRET_PATTERN.test(secret)) return false;

  try {
    window.sessionStorage.setItem(INVITE_SECRET_SESSION_KEY, secret.toLowerCase());
    return true;
  } catch(err) {
    return false;
  }
}

export function restorePrivateUsernameInviteSecretForRetry(
  secret: string
) {
  if(!INVITE_SECRET_PATTERN.test(secret)) return false;

  const normalizedSecret = secret.toLowerCase();
  inviteSecretFromFragment = normalizedSecret;
  return storePrivateUsernameInviteSecretForAccountSwitch(normalizedSecret);
}

// `src/index.ts` imports this dependency before the rest of the app graph so
// valid invite secrets leave the address bar before any app module runs.
if(typeof window !== 'undefined') capturePrivateUsernameInviteSecretFromFragment();
