const DEFAULT_DATABASES = new Set([
  'tweb', 'tweb-common', 'tweb-account-1', 'tweb-account-2', 'tweb-account-3', 'tweb-account-4', 'telegram'
]);

export function matchesServerDatabase(name: string, serverId: string) {
  if(serverId === 'default') return DEFAULT_DATABASES.has(name);
  return name === `tweb-${serverId}` || name === `telegram-${serverId}` || name.startsWith(`tweb-${serverId}-`);
}
