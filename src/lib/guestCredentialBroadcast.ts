import {getRuntimeServerId} from '@config/serverContext';

let invalidationSequence = 0;

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

export function listenForGuestCredentialInvalidation(serverId: string, callback: () => void) {
  let channel: BroadcastChannel | undefined;
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
  if(typeof window !== 'undefined') window.addEventListener('storage', onStorage);

  return () => {
    channel?.close();
    if(typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}
