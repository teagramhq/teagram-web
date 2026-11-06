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
  return `${storagePrefix(serverId)}guest-credential-lifecycle-clear.v1`;
}

export function notifyGuestCredentialInvalidation(serverId = getRuntimeServerId()) {
  if(typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(localInvalidationEvent, {detail: serverId}));
  try {
    if(typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(channelName(serverId));
      channel.postMessage({type: 'clear'});
      channel.close();
    }
  } catch{}

  try {
    const key = storageEventKey(serverId);
    localStorage.setItem(key, `${Date.now()}-${++invalidationSequence}`);
    localStorage.removeItem(key);
  } catch{}
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
    if(typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(channelName(serverId));
      channel.addEventListener('message', (event) => {
        if(event.data?.type === 'clear') callback();
      });
    }
  } catch{}
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
