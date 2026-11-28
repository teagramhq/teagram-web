import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  getTotalAccounts: vi.fn(async() => 1),
  hasSomeonePremium: vi.fn(async() => true),
  confirmationPopup: vi.fn(async() => {}),
  addAccount: vi.fn(async(_event: undefined, _forceSameTab: boolean, _hash?: string) => 'added'),
  toastNew: vi.fn()
}));

vi.mock('@lib/accounts/accountController', () => ({default: {getTotalAccounts: mocks.getTotalAccounts}}));
vi.mock('@lib/apiManagerProxy', () => ({default: {hasSomeonePremium: mocks.hasSomeonePremium}}));
vi.mock('@components/confirmationPopup', () => ({default: mocks.confirmationPopup}));
vi.mock('@components/sidebarLeft', () => ({default: {addAccount: mocks.addAccount}}));
vi.mock('@components/toast', () => ({toastNew: mocks.toastNew}));
vi.mock('@config/serverContext', async(importOriginal) => ({
  ...await importOriginal<typeof import('@config/serverContext')>(),
  getActiveServerHost: () => 'server.teagram.io',
  getRuntimeServerId: () => 'default'
}));

import {decodeFragmentLink} from '@/lib/fragmentLinkDecode';
import {handleSignedInInviteLink} from '@/pages/privateUsernameInviteFlow';

describe('v1 signup invite flow', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    mocks.getTotalAccounts.mockResolvedValue(1);
    mocks.hasSomeonePremium.mockResolvedValue(true);
    mocks.confirmationPopup.mockResolvedValue(undefined);
    mocks.addAccount.mockResolvedValue('added');
    mocks.toastNew.mockReset();
  });

  it('opens a new account slot with the v1 secret fragment held only in memory', async() => {
    const secret = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

    await handleSignedInInviteLink(secret, 'v1');

    expect(mocks.addAccount).toHaveBeenCalledWith(undefined, true, '#~RQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f');
    expect(decodeFragmentLink(mocks.addAccount.mock.calls[0][2] as string)).toEqual({
      type: 5,
      secret: Uint8Array.from({length: 32}, (_, index) => index)
    });
    expect(window.sessionStorage.getItem('teagram-invite-secret')).toBeNull();
  });

  it('keeps the legacy invite account switch handoff intact', async() => {
    const secret = 'a'.repeat(64);

    await handleSignedInInviteLink(secret);

    expect(mocks.addAccount).toHaveBeenCalledWith(undefined, true, undefined);
    expect(window.sessionStorage.getItem('teagram-invite-secret')).toBe(secret);
  });
});
