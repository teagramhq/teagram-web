import {getActiveDemoWipeGeneration, getActiveServerHost, getRuntimeServerId} from '@config/serverContext';
import {getMtprotoTarget} from '@config/mtprotoTarget';
import {getServerPin} from '@config/serverSelection';
import type {GuestServerIdentity} from '@lib/guestAccountTypes';

export function getActiveGuestServerIdentity(): GuestServerIdentity {
  const serverId = getRuntimeServerId();
  if(serverId === 'default') {
    const target = getMtprotoTarget();
    return {
      serverId,
      keyFingerprint: target.mode === 'private' ? target.fingerprint : 'telegram-default',
      wipeGeneration: getActiveDemoWipeGeneration()
    };
  }

  if(!/^custom-[0-9a-f]{64}$/.test(serverId)) {
    throw Object.assign(new Error('The selected server identity is invalid'), {type: 'GUEST_SERVER_ID_INVALID'});
  }
  const host = getActiveServerHost();
  const pin = host && getServerPin(host);
  if(!host || !pin || pin.host !== host || !/^[0-9a-f]{64}$/.test(pin.key_fingerprint)) {
    throw Object.assign(new Error('The selected server is not pinned'), {type: 'GUEST_SERVER_NOT_PINNED'});
  }
  return {serverId, keyFingerprint: pin.key_fingerprint, wipeGeneration: getActiveDemoWipeGeneration()};
}

export function isGuestServerIdentityCurrent(identity: GuestServerIdentity) {
  try {
    const current = getActiveGuestServerIdentity();
    return current.serverId === identity.serverId && current.keyFingerprint === identity.keyFingerprint &&
      current.wipeGeneration === identity.wipeGeneration;
  } catch{
    return false;
  }
}
