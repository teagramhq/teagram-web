import {getRuntimeServerId} from '@config/serverContext';
import {logger} from '@lib/logger';

let invalidationSequence = 0;
const localInvalidationEvent = 'guest-credential-lifecycle-local-clear';
const log = logger('[guest-credential-broadcast]');

function storagePrefix(serverId: string) {
  return serverId === 'default' ? '' : `teagram-${serverId}:`;
}

function channelName(serverId: string) {
  return `${storagePrefix(serverId)}guest-credential-lifecycle.v1`;
}

function storageEventKey(serverId: string) {
  return `${channelName(serverId).slice(0, -3)}-clear.v1`;
}

type TransportFailureMessage = 'BroadcastChannel delivery failed' | 'storage-event delivery failed' | 'BroadcastChannel listener setup failed';

function reportTransportFailure(message: TransportFailureMessage) {
  log.error(message);
}

export function notifyGuestCredentialInvalidation(serverId = getRuntimeServerId()) {
  if(typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(localInvalidationEvent, {detail: serverId}));
  try {
    const channel = new BroadcastChannel(channelName(serverId));
    try {
      channel.postMessage({type: 'clear'});
    } finally {
      channel.close();
    }
  } catch{
    reportTransportFailure('BroadcastChannel delivery failed');
  }

  try {
    if(typeof localStorage !== 'undefined') {
      const key = storageEventKey(serverId);
      localStorage.setItem(key, `${Date.now()}-${++invalidationSequence}`);
      localStorage.removeItem(key);
    }
  } catch{
    reportTransportFailure('storage-event delivery failed');
  }
}

export function listenForGuestCredentialInvalidation(serverId: string, callback: () => void, includeLocal = false) {
  let channel: BroadcastChannel | undefined;
  const onLocalInvalidation = (event: Event) => {
    if((event as CustomEvent<string>).detail === serverId) callback();
  };
  const onStorage = (event: StorageEvent) => {
    if(event.key === storageEventKey(serverId)) callback();
  };
  try {
    channel = new BroadcastChannel(channelName(serverId));
    channel.addEventListener('message', (event) => {
      if(event.data?.type === 'clear') callback();
    });
  } catch{
    reportTransportFailure('BroadcastChannel listener setup failed');
  }
  if(typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
    if(includeLocal) window.addEventListener(localInvalidationEvent, onLocalInvalidation);
  }

  return () => {
    channel?.close();
    if(typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
      if(includeLocal) window.removeEventListener(localInvalidationEvent, onLocalInvalidation);
    }
  };
}
