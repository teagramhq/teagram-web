const INVITE_SECRET_PATTERN = /^[\da-f]{64}$/i;
const INVITE_SECRET_SESSION_KEY = 'teagram-invite-secret';

let inviteSecretFromFragment: string | undefined;

export function parsePrivateUsernameInviteSecret(value: string): string | undefined {
  const trimmed = value.trim();
  const fragmentIndex = trimmed.lastIndexOf('#');
  const candidate = fragmentIndex === -1 ? trimmed : trimmed.slice(fragmentIndex + 1);
  if(!INVITE_SECRET_PATTERN.test(candidate)) return;
  return candidate.toLowerCase();
}

export function capturePrivateUsernameInviteSecretFromFragment() {
  const secret = window.location.hash.slice(1);
  if(!INVITE_SECRET_PATTERN.test(secret)) return;

  inviteSecretFromFragment = secret.toLowerCase();
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`
  );
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
