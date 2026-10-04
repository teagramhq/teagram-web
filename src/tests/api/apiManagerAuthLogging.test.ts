import {describe, expect, it, vi} from 'vitest';

import {ApiManager} from '@appManagers/apiManager';

describe.skipIf(!__MTPROTO_PRIVATE__)('private username auth error logging', () => {
  it('redacts auth.signIn params when SESSION_PASSWORD_NEEDED is logged', async() => {
    const logError = vi.fn();
    const params = {
      phone_number: 'Alice_123',
      phone_code_hash: 'mock-code-hash',
      phone_code: ''
    };
    const networker = {
      wrapApiCall: vi.fn().mockRejectedValue({code: 401, type: 'SESSION_PASSWORD_NEEDED'}),
      attachPromise: vi.fn()
    };
    const manager = Object.create(ApiManager.prototype) as ApiManager;
    Object.assign(manager, {
      baseDcId: 2,
      log: {error: logError},
      getNetworker: vi.fn().mockResolvedValue(networker)
    });

    await expect(manager.invokeApi('auth.signIn', params, {dcId: 2, ignoreErrors: true}))
    .rejects.toMatchObject({type: 'SESSION_PASSWORD_NEEDED'});

    expect(logError).toHaveBeenCalledOnce();
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toContain('Alice_123');
    expect(logged).not.toContain('mock-code-hash');
    expect(logged).toContain('[REDACTED]');
    expect(manager.log.error).toBe(logError);
  });
});
