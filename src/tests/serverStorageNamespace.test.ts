import {afterEach, describe, expect, it} from 'vitest';
import {scopeServerDatabaseName, scopeServerStorageKey} from '@config/serverContext';
import {IDB} from '@lib/files/idb';

const runtime = globalThis as any;
const idbInstances = (IDB as any).INSTANCES as Array<any>;
const originalIdbInstances = [...idbInstances];

afterEach(() => {
  delete runtime.__TEAGRAM_ACTIVE_SERVER_ID__;
  idbInstances.splice(0, idbInstances.length, ...originalIdbInstances);
});

describe('server storage namespaces', () => {
  it('keeps existing default database and localStorage names', () => {
    expect(scopeServerDatabaseName('tweb-common')).toBe('tweb-common');
    expect(scopeServerDatabaseName('tweb-account-1')).toBe('tweb-account-1');
    expect(scopeServerStorageKey('dc2_auth_key')).toBe('dc2_auth_key');
  });

  it('makes another server unable to read the previous server auth keys and databases', () => {
    const storage = new Map<string, string>();
    runtime.__TEAGRAM_ACTIVE_SERVER_ID__ = 'custom-' + 'a'.repeat(64);
    storage.set(scopeServerStorageKey('dc2_auth_key'), 'server-a-auth-key');
    const accountDbA = scopeServerDatabaseName('tweb-account-1');
    const commonDbA = scopeServerDatabaseName('tweb-common');

    runtime.__TEAGRAM_ACTIVE_SERVER_ID__ = 'custom-' + 'b'.repeat(64);
    expect(storage.get(scopeServerStorageKey('dc2_auth_key'))).toBeUndefined();
    expect(scopeServerDatabaseName('tweb-account-1')).not.toBe(accountDbA);
    expect(scopeServerDatabaseName('tweb-common')).not.toBe(commonDbA);
  });

  it('closes the unscoped default databases when shutting down the default worker', async() => {
    const closedDatabases: string[] = [];
    const defaultDatabases = ['tweb', 'telegram', 'tweb-common', 'tweb-account-1', 'tweb-account-2', 'tweb-account-3', 'tweb-account-4'];
    const otherServerId = 'custom-' + 'b'.repeat(64);
    idbInstances.splice(0, idbInstances.length, ...[
      ...defaultDatabases,
      `tweb-${otherServerId}`,
      `tweb-${otherServerId}-common`,
      `telegram-${otherServerId}`
    ].map((name) => ({name, closeDatabase: async() => { closedDatabases.push(name); }})));

    await IDB.closeDatabasesForServer('default');

    expect(closedDatabases.sort()).toEqual([...defaultDatabases].sort());
  });
});
