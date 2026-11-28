import {afterEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({reload: vi.fn()}));
vi.mock('@components/appNavigationController', () => ({default: {reload: mocks.reload}}));

import {changeAccount} from '@lib/accounts/changeAccount';

describe('account switching', () => {
  afterEach(() => {
    mocks.reload.mockReset();
  });

  it('passes an invite fragment into the new account slot without keeping the current fragment', () => {
    window.history.replaceState(window.history.state, '', '/?keep=1#old');

    changeAccount(2 as any, false, false, '#~RQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f');

    const nextUrl = mocks.reload.mock.calls[0][0] as URL;
    expect(nextUrl.searchParams.get('keep')).toBe('1');
    expect(nextUrl.searchParams.get('account')).toBe('2');
    expect(nextUrl.hash).toBe('#~RQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f');
  });
});
