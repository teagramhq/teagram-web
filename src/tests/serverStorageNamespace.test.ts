import {afterEach, describe, expect, it} from 'vitest';
import {scopeServerDatabaseName, scopeServerStorageKey} from '@config/serverContext';

const runtime = globalThis as any;

afterEach(() => {
  delete runtime.__TEAGRAM_ACTIVE_SERVER_ID__;
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
});
