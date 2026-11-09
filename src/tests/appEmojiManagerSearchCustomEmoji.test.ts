import {describe, expect, it, vi} from 'vitest';
import {AppEmojiManager} from '@appManagers/appEmojiManager';

const makeManager = (invokeApiCacheable: (...args: any[]) => any) => {
  const manager: any = Object.create(AppEmojiManager.prototype);
  manager.apiManager = {invokeApiCacheable};
  return manager as AppEmojiManager;
};

describe('AppEmojiManager.searchCustomEmoji', () => {
  it('returns an empty list when the server does not implement custom emoji search', async() => {
    const invokeApiCacheable = vi.fn().mockRejectedValue({type: 'INPUT_METHOD_INVALID', code: 400});
    const manager = makeManager(invokeApiCacheable);

    await expect(manager.searchCustomEmoji('👍')).resolves.toEqual({
      _: 'emojiList',
      hash: 0,
      document_id: []
    });
    expect(invokeApiCacheable).toHaveBeenCalledWith(
      'messages.searchCustomEmoji',
      {hash: 0, emoticon: '👍'},
      {cacheSeconds: 3600, syncIfHasResult: true}
    );
  });

  it('keeps unexpected search errors visible to the caller', async() => {
    const error = {type: 'NETWORK_ERROR'};
    const manager = makeManager(vi.fn().mockRejectedValue(error));

    await expect(manager.searchCustomEmoji('👍')).rejects.toBe(error);
  });

  it('handles a cached unsupported-method error thrown synchronously', async() => {
    const manager = makeManager(vi.fn(() => {
      throw {type: 'INPUT_METHOD_INVALID', code: 400};
    }));

    await expect(manager.searchCustomEmoji('👍')).resolves.toEqual({
      _: 'emojiList',
      hash: 0,
      document_id: []
    });
  });
});
