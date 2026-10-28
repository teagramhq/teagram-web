import {afterEach, describe, expect, it, vi} from 'vitest';

import {ApiManager} from '@appManagers/apiManager';
import AccountController from '@lib/accounts/accountController';
import rootScope from '@lib/rootScope';
import sessionStorage from '@lib/sessionStorage';

afterEach(() => vi.restoreAllMocks());

describe('account reauthorization', () => {
  it('persists the new-account marker through reauthorization', async() => {
    const accountData: Record<string, any> = {dcId: 2};
    vi.spyOn(rootScope, 'dispatchEvent').mockImplementation(() => undefined as any);
    vi.spyOn(sessionStorage, 'get').mockImplementation(async(key: any) => {
      return key === 'account2' ? structuredClone(accountData) : undefined as any;
    });
    vi.spyOn(sessionStorage, 'getFresh').mockImplementation(async(key: any) => {
      return key === 'account2' ? structuredClone(accountData) : undefined as any;
    });
    vi.spyOn(sessionStorage, 'set').mockImplementation(async(data: any) => {
      if(data.account2) Object.assign(accountData, structuredClone(data.account2));
    });
    vi.spyOn(sessionStorage, 'flush').mockResolvedValue(undefined);
    vi.spyOn(AccountController, 'getTotalAccounts').mockResolvedValue(1);

    const manager = Object.create(ApiManager.prototype) as ApiManager;
    Object.assign(manager, {
      accountNumber: 2,
      baseDcId: 2,
      rootScope: {dispatchEvent: vi.fn()},
      appUsersManager: {saveApiUser: vi.fn()}
    });

    await manager.setUserAuth({id: 42, dcID: 2, date: 1} as any, true);
    expect(accountData.newAccountUserId).toBe(42);

    await manager.setUserAuth({id: 42, dcID: 2, date: 2} as any);

    expect(accountData.newAccountUserId).toBe(42);
  });

  it('passes the new-account status into auth persistence', async() => {
    const dispatchEvent = vi.spyOn(rootScope, 'dispatchEvent').mockImplementation(() => undefined as any);
    vi.spyOn(AccountController, 'get').mockResolvedValue({newAccountUserId: 42} as any);
    const manager = Object.create(ApiManager.prototype) as ApiManager;
    Object.assign(manager, {
      accountNumber: 2,
      appUsersManager: {saveApiUser: vi.fn()}
    });
    const setUserAuth = vi.spyOn(manager, 'setUserAuth').mockResolvedValue(undefined);

    await manager.setUser({_: 'user', id: 42} as any, true);
    await manager.setUser({_: 'user', id: 42} as any);

    expect(setUserAuth).toHaveBeenCalledWith(42, true);
    expect(setUserAuth).toHaveBeenCalledWith(42, false);
    expect(dispatchEvent).toHaveBeenLastCalledWith('account_logged_in', {
      accountNumber: 2,
      userId: 42,
      isNewAccount: true
    });
  });
});
