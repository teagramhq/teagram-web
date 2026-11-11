import {
  ACTIVE_SERVER_ID_KEY,
  getServerProfileId,
  normalizeServerHost,
  SERVER_CHOICE_KEY,
  SERVER_TARGET_KEY,
  updateServerPins
} from '@config/serverSelection';
import {notifyGuestCredentialInvalidation} from '@lib/guestCredentialBroadcast';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function forgetServerData(hostInput: string, profileId: string) {
  if(typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('This browser cannot safely update server pins');
  }
  const host = normalizeServerHost(hostInput);
  const id = getServerProfileId(host, profileId);
  notifyGuestCredentialInvalidation(id);
  const belongsToProfile = (key: string) => id === 'default' ?
    !key.startsWith('teagram.') && !/^teagram-custom-[0-9a-f]{64}:/.test(key) : key.startsWith(`teagram-${id}:`);
  for(const key of Object.keys(localStorage)) {
    if(belongsToProfile(key)) localStorage.removeItem(key);
  }
  for(const key of Object.keys(sessionStorage)) {
    if(belongsToProfile(key)) sessionStorage.removeItem(key);
  }
  const suffix = id === 'default' ? '' : `-${id}`;
  const knownDatabases = [`tweb${suffix}`, `tweb${suffix}-common`, ...[1, 2, 3, 4].map((account) => `tweb${suffix}-account-${account}`), `telegram${suffix}`];
  const databases = indexedDB.databases ? await indexedDB.databases() : [];
  const databaseNames = new Set([
    ...knownDatabases,
    ...databases.map((database) => database.name).filter((name): name is string => !!name && id !== 'default' &&
      (name.startsWith(`tweb-${id}-`) || name === `tweb-${id}` || name === `telegram-${id}`))
  ]);
  await Promise.all([...databaseNames].map((name) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error(`Could not remove server database ${name}`));
    request.onblocked = () => reject(new Error('Close other tabs using this server before forgetting it'));
  })));
  if(typeof caches !== 'undefined') {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.filter((name) => id === 'default' ? name === 'cachedAssets' :
      name.startsWith(`teagram-${id}-`)).map((name) => caches.delete(name)));
  }

  await updateServerPins((pins) => { delete pins[host]; });
  if(localStorage.getItem(SERVER_CHOICE_KEY) === host) localStorage.removeItem(SERVER_CHOICE_KEY);
  if(localStorage.getItem(ACTIVE_SERVER_ID_KEY) === id) localStorage.removeItem(ACTIVE_SERVER_ID_KEY);
  try {
    const savedTarget: unknown = JSON.parse(localStorage.getItem(SERVER_TARGET_KEY) || 'null');
    if(!record(savedTarget) || savedTarget.host === host) {
      localStorage.removeItem(SERVER_TARGET_KEY);
    }
  } catch{
    localStorage.removeItem(SERVER_TARGET_KEY);
  }
}
