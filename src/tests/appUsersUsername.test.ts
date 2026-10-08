import {describe, expect, it, vi} from 'vitest';
import {AppUsersManager} from '@appManagers/appUsersManager';

describe('updateUsername cache ownership', () => {
  it('keeps the cached username unchanged when the server rejects an update', async() => {
    const manager = new AppUsersManager();
    const myId = 100 as UserId;
    const cachedUser = {_: 'user', id: myId, username: 'operator'} as any;
    const error = {type: 'USERNAME_IMMUTABLE'};
    const invokeApi = vi.fn().mockRejectedValue(error);
    const saveApiUser = vi.spyOn(manager, 'saveApiUser').mockImplementation(() => undefined);
    Object.assign(manager, {
      users: {[myId]: cachedUser},
      apiManager: {invokeApi}
    });

    await expect(manager.updateUsername('newhandle')).rejects.toBe(error);

    expect(invokeApi).toHaveBeenCalledWith('account.updateUsername', {username: 'newhandle'});
    expect((manager as any).users[myId].username).toBe('operator');
    expect(saveApiUser).not.toHaveBeenCalled();
  });

  it('saves only the user object returned by a successful server update', async() => {
    const manager = new AppUsersManager();
    const returnedUser = {_: 'user', id: 100, username: 'newhandle'} as any;
    const invokeApi = vi.fn().mockResolvedValue(returnedUser);
    const saveApiUser = vi.spyOn(manager, 'saveApiUser').mockImplementation(() => undefined);
    Object.assign(manager, {apiManager: {invokeApi}});

    await manager.updateUsername('newhandle');

    expect(saveApiUser).toHaveBeenCalledExactlyOnceWith(returnedUser);
  });
});
