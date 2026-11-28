import {decodeV1InviteSecret} from '@lib/fragmentLinkDecode';

const INVITE_SECRET_PATTERN = /^[\da-f]{64}$/i;

let v1InviteSecretFromFragment: string | undefined;

export function resolvePrivateUsernameV1InviteSecret(fragment: string) {
  try {
    v1InviteSecretFromFragment = decodeV1InviteSecret(fragment);
  } catch{}
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
