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

type TransportFailureOperation = 'broadcast' | 'storage' | 'listener';

function reportTransportFailure(operation: TransportFailureOperation) {
  console.error(operation);
}

export function notifyGuestCredentialInvalidation(serverId = getRuntimeServerId()) {
  if(typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(localInvalidationEvent, {detail: serverId}));
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(channelName(serverId));
    channel.postMessage({type: 'clear'});
  } catch{
    reportTransportFailure('broadcast');
  }
  channel?.close();

  try {
    // Workers such as SharedWorker have no localStorage; skip delivery there instead of reporting a failure.
    const storage = self.localStorage;
    const key = storageEventKey(serverId);
    storage?.setItem(key, `${Date.now()}-${++invalidationSequence}`);
    storage?.removeItem(key);
  } catch{
    reportTransportFailure('storage');
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
    reportTransportFailure('listener');
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
