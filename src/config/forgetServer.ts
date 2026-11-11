import type {ServerPin} from '@config/serverSelection';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function forgetServerData(
  host: string,
  id: string,
  updateServerPins: (update: (pins: Record<string, ServerPin>) => void) => Promise<unknown>,
  notifyGuestCredentialInvalidation: (serverId: string) => void
) {
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
  if(localStorage.getItem('teagram.server-choice.v1') === host) localStorage.removeItem('teagram.server-choice.v1');
  if(localStorage.getItem('teagram.active-server-id.v1') === id) localStorage.removeItem('teagram.active-server-id.v1');
  try {
    const savedTarget: unknown = JSON.parse(localStorage.getItem('teagram.server-target.v1') || 'null');
    if(!record(savedTarget) || savedTarget.host === host) {
      localStorage.removeItem('teagram.server-target.v1');
    }
  } catch{
    localStorage.removeItem('teagram.server-target.v1');
  }
}
