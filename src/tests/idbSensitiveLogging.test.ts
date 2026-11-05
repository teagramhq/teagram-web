import {describe, expect, it, vi} from 'vitest';
import type {Database} from '@config/databases';
import IDBStorage from '@lib/files/idb';

const database: Database<'session'> = {
  name: `telegram-sensitive-logging-${Date.now()}`,
  version: 1,
  stores: [{name: 'session'}]
};
const token = `123456789:${'A'.repeat(35)}`;

describe('IndexedDB sensitive-value logging', () => {
  it('runs the real IDBStorage read logger and redacts sensitive values', async() => {
    const storage = new IDBStorage(database, 'session');
    const log = vi.fn();
    (storage as any).log = log;

    try {
      await storage.save('telegramBotToken', token);
      const value = await (storage as any).getObjectStore(
        'readonly',
        (objectStore: IDBObjectStore) => objectStore.get('telegramBotToken'),
        'get telegramBotToken',
        'session',
        true
      );

      expect(value).toBe(token);
      expect(log).toHaveBeenCalledWith('get telegramBotToken: resolved', '[redacted]');
      expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    } finally {
      await storage.clear();
      await storage.close();
    }
  });
});
