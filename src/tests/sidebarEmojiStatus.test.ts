import {beforeEach, describe, expect, it, vi} from 'vitest';
import {getSidebarEmojiStatus, optionalStatuses, updateSidebarEmojiStatus} from '@components/sidebarLeft/emojiStatus';

const mocks = vi.hoisted(() => ({error: vi.fn()}));

vi.mock('@lib/logger', () => ({logger: () => ({error: mocks.error})}));

describe('sidebar emoji status', () => {
  beforeEach(() => mocks.error.mockClear());

  it('reports a missing current user instead of treating it as an empty status', () => {
    expect(() => getSidebarEmojiStatus(undefined)).toThrow('Current user is unavailable while rendering emoji status');
    expect(() => getSidebarEmojiStatus({_: 'userEmpty', id: 1})).toThrow('Current user is unavailable while rendering emoji status');
  });

  it('returns an existing current-user emoji status', () => {
    const status = {_: 'emojiStatus', document_id: '42'};
    const user = {_: 'user', id: 1, emoji_status: status} as any;

    expect(getSidebarEmojiStatus(user)).toBe(status);
  });

  it('reports a rejected status render to the app error handler', async() => {
    const error = new Error('status render failed');
    const reportError = vi.fn();

    await updateSidebarEmojiStatus(async() => {
      throw error;
    }, reportError);

    expect(reportError).toHaveBeenCalledWith(error);
  });

  it('ignores unsupported optional emoji status lists', async() => {
    await expect(optionalStatuses(Promise.reject({type: 'INPUT_METHOD_INVALID'}))).resolves.toBeUndefined();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('logs other optional emoji status list failures but keeps the list optional', async() => {
    const error = new Error('network failed');
    await expect(optionalStatuses(Promise.reject(error))).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith('Optional emoji status list failed', error);
  });
});
