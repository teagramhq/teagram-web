import {afterEach, describe, expect, test, vi} from 'vitest';
import {AppPrivacyManager} from '@appManagers/appPrivacyManager';
import {RootScope} from '@lib/rootScope';

describe('privacy settings preload', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('keeps content settings on auth and defers global privacy until the list is interactive', () => {
    vi.useFakeTimers();
    const rootScope = new RootScope();
    const manager = new AppPrivacyManager;
    const getContentSettings = vi.spyOn(manager, 'getContentSettings').mockReturnValue(Promise.resolve({} as any));
    const getGlobalPrivacySettings = vi.spyOn(manager, 'getGlobalPrivacySettings').mockResolvedValue({} as any);
    (manager as any).rootScope = rootScope;
    (manager as any).apiUpdatesManager = {addMultipleEventsListeners: vi.fn()};
    (manager as any).after();

    rootScope.dispatchEventSingle('user_auth', {} as any);
    expect(getContentSettings).toHaveBeenCalledOnce();
    expect(getGlobalPrivacySettings).not.toHaveBeenCalled();

    rootScope.dispatchEventSingle('chat_list_interactive');
    vi.advanceTimersByTime(99);
    expect(getGlobalPrivacySettings).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(getGlobalPrivacySettings).toHaveBeenCalledOnce();

    rootScope.cleanup();
  });
});
