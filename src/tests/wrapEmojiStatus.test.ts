import {beforeEach, describe, expect, it, vi} from 'vitest';
import wrapEmojiStatus from '@components/wrappers/emojiStatus';

const mocks = vi.hoisted(() => ({
  wrapSticker: vi.fn(),
  rootScope: {
    managers: {
      acknowledged: {
        appEmojiManager: {
          getCustomEmojiDocument: vi.fn()
        }
      }
    }
  }
}));

vi.mock('@lib/rootScope', () => ({default: mocks.rootScope}));
vi.mock('@components/wrappers/sticker', () => ({default: mocks.wrapSticker}));

describe('wrapEmojiStatus', () => {
  const status = {_: 'emojiStatus', document_id: '42'} as any;
  const doc: any = {attributes: [], mime_type: 'application/x-tgsticker'};

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wrapSticker.mockReset();
    mocks.rootScope.managers.acknowledged.appEmojiManager.getCustomEmojiDocument.mockReset();
    mocks.rootScope.managers.acknowledged.appEmojiManager.getCustomEmojiDocument.mockResolvedValue({
      cached: true,
      result: Promise.resolve(doc)
    });
  });

  it('treats a cancelled custom emoji render as a normal teardown', async() => {
    let active = true;
    const middleware = () => active;
    mocks.wrapSticker.mockImplementation(async() => {
      active = false;
      throw {type: 'MIDDLEWARE'};
    });

    const result = await wrapEmojiStatus({
      emojiStatus: status,
      wrapOptions: {middleware} as any,
      size: {width: 24, height: 24} as any
    });

    expect(result.classList.contains('emoji-status')).toBe(true);
    expect(mocks.wrapSticker).toHaveBeenCalledOnce();
  });

  it('does not leak a cancelled sticker load when the status is torn down mid-render', async() => {
    let active = true;
    mocks.wrapSticker.mockImplementation(async({loadPromises}: any) => {
      loadPromises.push(Promise.reject({type: 'MIDDLEWARE'}));
      active = false;
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    await wrapEmojiStatus({
      emojiStatus: status,
      wrapOptions: {middleware: () => active} as any,
      size: {width: 24, height: 24} as any
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it('keeps non-cancellation render failures observable', async() => {
    mocks.wrapSticker.mockRejectedValue(new Error('sticker load failed'));

    await expect(wrapEmojiStatus({
      emojiStatus: status,
      wrapOptions: {middleware: () => true} as any,
      size: {width: 24, height: 24} as any
    })).rejects.toThrow('sticker load failed');
  });
});
