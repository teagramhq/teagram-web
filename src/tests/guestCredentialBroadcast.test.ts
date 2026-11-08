import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {listenForGuestCredentialInvalidation, notifyGuestCredentialInvalidation} from '@lib/guestCredentialBroadcast';

const storageEventKey = 'guest-credential-lifecycle-clear.v1';
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function subscribeToLocalInvalidation() {
  const callback = vi.fn();
  unsubscribe = listenForGuestCredentialInvalidation('default', callback, true);
  return callback;
}

function expectLoggedError(message: string) {
  expect(vi.mocked(console.error).mock.calls.some((args) => {
    return args.includes('[[guest-credential-broadcast]]') && args.includes(message);
  })).toBe(true);
}

describe('guest credential invalidation delivery', () => {
  it('reports BroadcastChannel failure and still uses the storage fallback and same-tab event', () => {
    vi.stubGlobal('BroadcastChannel', class {
      constructor() {
        throw new Error('account secret must not be logged');
      }
    });
    const callback = subscribeToLocalInvalidation();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.mocked(console.error).mockClear();

    notifyGuestCredentialInvalidation('default');

    expect(callback).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(storageEventKey, expect.any(String));
    expect(localStorage.getItem(storageEventKey)).toBeNull();
    expectLoggedError('BroadcastChannel delivery failed');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('account secret');
  });

  it('reports storage-event failure while still using BroadcastChannel and same-tab event', () => {
    const postMessage = vi.fn();
    vi.stubGlobal('BroadcastChannel', class {
      postMessage = postMessage;
      close = vi.fn();
      addEventListener = vi.fn();
    });
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key: string, value: string) {
      if(key === storageEventKey) throw new Error('account secret must not be logged');
      return originalSetItem.call(this, key, value);
    });
    const callback = subscribeToLocalInvalidation();
    vi.mocked(console.error).mockClear();

    notifyGuestCredentialInvalidation('default');

    expect(callback).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({type: 'clear'});
    expectLoggedError('storage-event delivery failed');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('account secret');
  });

  it('reports both delivery failures without exposing credential or account values', () => {
    vi.stubGlobal('BroadcastChannel', class {
      constructor() {
        throw new Error('account secret must not be logged');
      }
    });
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key: string, value: string) {
      if(key === storageEventKey) throw new Error('username secret must not be logged');
      return originalSetItem.call(this, key, value);
    });
    const callback = subscribeToLocalInvalidation();
    vi.mocked(console.error).mockClear();

    notifyGuestCredentialInvalidation('default');

    expect(callback).toHaveBeenCalledOnce();
    expectLoggedError('BroadcastChannel delivery failed');
    expectLoggedError('storage-event delivery failed');
    const report = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(report).not.toContain('account secret');
    expect(report).not.toContain('username secret');
  });

  it('reports a BroadcastChannel listener setup failure and keeps the storage listener active', () => {
    vi.stubGlobal('BroadcastChannel', class {
      constructor() {
        throw new Error('account secret must not be logged');
      }
    });
    const callback = vi.fn();
    unsubscribe = listenForGuestCredentialInvalidation('default', callback);

    expectLoggedError('BroadcastChannel listener setup failed');

    window.dispatchEvent(new StorageEvent('storage', {key: storageEventKey}));

    expect(callback).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('account secret');
  });

  it('closes a BroadcastChannel after posting fails and still uses the storage fallback', () => {
    const close = vi.fn();
    vi.stubGlobal('BroadcastChannel', class {
      postMessage = vi.fn(() => { throw new Error('account secret must not be logged'); });
      close = close;
      addEventListener = vi.fn();
    });
    const callback = subscribeToLocalInvalidation();
    vi.mocked(console.error).mockClear();

    notifyGuestCredentialInvalidation('default');

    expect(callback).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(localStorage.getItem(storageEventKey)).toBeNull();
    expectLoggedError('BroadcastChannel delivery failed');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('account secret');
  });

  it('reports an unavailable BroadcastChannel and still uses the storage fallback', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const callback = subscribeToLocalInvalidation();
    vi.mocked(console.error).mockClear();

    notifyGuestCredentialInvalidation('default');

    expect(callback).toHaveBeenCalledOnce();
    expect(localStorage.getItem(storageEventKey)).toBeNull();
    expectLoggedError('BroadcastChannel delivery failed');
  });

  it('skips storage-event delivery when localStorage is unavailable', () => {
    const postMessage = vi.fn();
    vi.stubGlobal('BroadcastChannel', class {
      postMessage = postMessage;
      close = vi.fn();
    });
    vi.stubGlobal('localStorage', undefined);

    notifyGuestCredentialInvalidation('default');

    expect(postMessage).toHaveBeenCalledWith({type: 'clear'});
    expect(console.error).not.toHaveBeenCalled();
  });

  it('preserves server IDs containing the channel version when deriving the storage key', () => {
    const channelNames: string[] = [];
    vi.stubGlobal('BroadcastChannel', class {
      constructor(name: string) {
        channelNames.push(name);
      }
      addEventListener = vi.fn();
      close = vi.fn();
    });
    const callback = vi.fn();
    unsubscribe = listenForGuestCredentialInvalidation('server.v1', callback);

    expect(channelNames).toEqual(['teagram-server.v1:guest-credential-lifecycle.v1']);
    window.dispatchEvent(new StorageEvent('storage', {key: 'teagram-server.v1:guest-credential-lifecycle-clear.v1'}));

    expect(callback).toHaveBeenCalledOnce();
  });
});
