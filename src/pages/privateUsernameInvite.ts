const INVITE_SECRET_PATTERN = /^[\da-f]{64}$/i;
const INVITE_SECRET_SESSION_KEY = 'teagram-invite-secret';
// Version 1, type 5 (invite), with or without a host: the first two code characters.
const V1_INVITE_PREFIX = /^#~[RZ][Q-Za-f]/;

let inviteSecretFromFragment: string | undefined;
let v1InviteFragment: string | undefined;

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

  if(!V1_INVITE_PREFIX.test(fragment)) return;
  // The address bar is cleared and the raw code is held here before any other code runs;
  // the strict decoder is a separate chunk, so it only loads when an invite link arrives.
  clearFragment();
  v1InviteFragment = fragment;
}

export function takePrivateUsernameV1InviteFragment() {
  const fragment = v1InviteFragment;
  v1InviteFragment = undefined;
  return fragment;
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
