import {getRuntimeServerId} from '@config/serverContext';

let invalidationSequence = 0;
const localInvalidationEvent = 'guest-credential-lifecycle-local-clear';

function storagePrefix(serverId: string) {
  return serverId === 'default' ? '' : `teagram-${serverId}:`;
}

function channelName(serverId: string) {
  return `${storagePrefix(serverId)}guest-credential-lifecycle.v1`;
}

function storageEventKey(serverId: string) {
  return `${channelName(serverId).slice(0, -3)}-clear.v1`;
}

function reportTransportFailure() {
  console.error(localInvalidationEvent, 'failed');
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
    reportTransportFailure();
  }

  try {
    const key = storageEventKey(serverId);
    localStorage.setItem(key, `${Date.now()}-${++invalidationSequence}`);
    localStorage.removeItem(key);
  } catch{
    reportTransportFailure();
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
    reportTransportFailure();
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
