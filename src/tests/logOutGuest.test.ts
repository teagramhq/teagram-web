import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmationPopup: vi.fn(),
  logOut: vi.fn(),
  forgetGuest: vi.fn(),
  toastNew: vi.fn()
}));

vi.mock('@components/confirmationPopup', () => ({default: mocks.confirmationPopup}));
vi.mock('@components/toast', () => ({toastNew: mocks.toastNew}));
vi.mock('@lib/rootScope', () => ({default: {managers: {apiManager: {logOut: mocks.logOut}}}}));
vi.mock('@lib/guestAccountLifecycle', () => ({
  createCurrentGuestAccountLifecycle: () => ({forget: mocks.forgetGuest})
}));

import showLogOutPopup from '@components/popups/logOut';

describe('guest sign-out confirmation', () => {
  beforeEach(() => {
    mocks.confirmationPopup.mockReset().mockResolvedValue(undefined);
    mocks.logOut.mockReset();
    mocks.forgetGuest.mockReset().mockResolvedValue({kind: 'forgotten'});
    mocks.toastNew.mockReset();
  });

  it('warns before signing out and uses the guest lifecycle after confirmation', async() => {
    showLogOutPopup();

    expect(mocks.confirmationPopup).toHaveBeenCalledWith(expect.objectContaining({
      descriptionLangKey: 'Teagram.Guest.SignOutWarning'
    }));
    await vi.waitFor(() => expect(mocks.forgetGuest).toHaveBeenCalledOnce());
    expect(mocks.logOut).not.toHaveBeenCalled();
  });

  it('uses regular sign-out when the current account is not a saved guest', async() => {
    mocks.forgetGuest.mockResolvedValueOnce({kind: 'noGuest'});

    showLogOutPopup();

    await vi.waitFor(() => expect(mocks.logOut).toHaveBeenCalledOnce());
    expect(mocks.forgetGuest).toHaveBeenCalledOnce();
  });

  it('keeps the guest session if forgetting credentials fails', async() => {
    mocks.forgetGuest.mockResolvedValueOnce({kind: 'error', errorType: 'NETWORK_ERROR'});

    showLogOutPopup();

    await vi.waitFor(() => expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Teagram.Guest.SignOutFailed'}));
    expect(mocks.logOut).not.toHaveBeenCalled();
  });

  it('shows a general sign-out error when a regular account cannot log out', async() => {
    mocks.forgetGuest.mockResolvedValueOnce({kind: 'noGuest'});
    mocks.logOut.mockRejectedValueOnce(new Error('offline'));

    showLogOutPopup();

    await vi.waitFor(() => expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Teagram.SignOutFailed'}));
  });
});
