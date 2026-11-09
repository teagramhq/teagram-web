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

  it('consumes a cancelled render when the status is torn down after wrapper setup', async() => {
    let rejectRender!: (error: unknown) => void;
    const render = new Promise<void>((_resolve, reject) => {
      rejectRender = reject;
    });
    let active = true;
    mocks.wrapSticker.mockResolvedValue({render} as any);
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const result = wrapEmojiStatus({
        emojiStatus: status,
        wrapOptions: {middleware: () => active} as any,
        size: {width: 24, height: 24} as any
      });
      await vi.waitFor(() => expect(mocks.wrapSticker).toHaveBeenCalledOnce());
      active = false;
      rejectRender({type: 'MIDDLEWARE'});

      await expect(result).resolves.toBeInstanceOf(HTMLElement);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('keeps non-cancellation render failures observable after status teardown', async() => {
    let rejectRender!: (error: Error) => void;
    const render = new Promise<void>((_resolve, reject) => {
      rejectRender = reject;
    });
    let active = true;
    mocks.wrapSticker.mockResolvedValue({render} as any);

    const result = wrapEmojiStatus({
      emojiStatus: status,
      wrapOptions: {middleware: () => active} as any,
      size: {width: 24, height: 24} as any
    });
    await vi.waitFor(() => expect(mocks.wrapSticker).toHaveBeenCalledOnce());
    active = false;
    const error = new Error('render failed after teardown');
    rejectRender(error);

    await expect(result).rejects.toBe(error);
  });

  it('keeps real sticker load failures observable after the status is torn down', async() => {
    let active = true;
    const error = new Error('sticker load failed after teardown');
    mocks.wrapSticker.mockImplementation(async({loadPromises}: any) => {
      loadPromises.push(Promise.reject(error));
      active = false;
    });

    await expect(wrapEmojiStatus({
      emojiStatus: status,
      wrapOptions: {middleware: () => active} as any,
      size: {width: 24, height: 24} as any
    })).rejects.toBe(error);
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
