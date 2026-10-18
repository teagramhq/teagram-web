type RuntimeGlobal = typeof globalThis & {
  __TEAGRAM_ACTIVE_SERVER_ID__?: string,
  __TEAGRAM_ACTIVE_MTPROTO_TARGET__?: unknown
};

const runtimeGlobal = globalThis as RuntimeGlobal;

export function getActiveServerId() {
  if(runtimeGlobal.__TEAGRAM_ACTIVE_SERVER_ID__) return runtimeGlobal.__TEAGRAM_ACTIVE_SERVER_ID__;
  if(typeof Window === 'undefined' && typeof location !== 'undefined') {
    const id = new URL(location.href).searchParams.get('__tg_server');
    if(id && /^custom-[0-9a-f]{64}$/.test(id)) return id;
  }
  return 'default';
}

export function getServerStoragePrefix() {
  const id = getActiveServerId();
  return id === 'default' ? '' : `teagram-${id}:`;
}

export function scopeServerStorageKey(key: string) {
  return getServerStoragePrefix() + key;
}

export function scopeServerDatabaseName(name: string) {
  const id = getActiveServerId();
  if(id === 'default') return name;
  if(name === 'tweb') return `tweb-${id}`;
  if(name.startsWith('tweb-')) return `tweb-${id}-${name.slice('tweb-'.length)}`;
  if(name === 'telegram') return `telegram-${id}`;
  return `teagram-${id}-${name}`;
}

export function readWorkerMtprotoTarget() {
  if(runtimeGlobal.__TEAGRAM_ACTIVE_MTPROTO_TARGET__) {
    return runtimeGlobal.__TEAGRAM_ACTIVE_MTPROTO_TARGET__;
  }
  if(typeof Window === 'undefined' && typeof location !== 'undefined') {
    const target = new URL(location.href).searchParams.get('__tg_target');
    if(target) {
      try {
        const standard = target.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = atob(standard + '='.repeat((4 - standard.length % 4) % 4));
        return JSON.parse(decoded);
      } catch{
        throw new Error('[MT] worker target metadata is invalid');
      }
    }
  }
}

export function getRuntimeServerId() {
  return runtimeGlobal.__TEAGRAM_ACTIVE_SERVER_ID__ || getActiveServerId();
}
