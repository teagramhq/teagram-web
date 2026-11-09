import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import wrapSticker, {handleStickerError} from '@components/wrappers/sticker';

const mocks = vi.hoisted(() => {
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/webp;base64,';
  return {
    getCacheContext: vi.fn(),
    downloadMediaURL: vi.fn(),
    createStickerAppearance: vi.fn(() => ({}))
  };
});

vi.mock('@lib/apiManagerProxy', () => ({default: {getCacheContext: mocks.getCacheContext}}));
vi.mock('@lib/appDownloadManager', () => ({default: {downloadMediaURL: mocks.downloadMediaURL}}));
vi.mock('@appManagers/utils/stickers/getStickerEffectThumb', () => ({default: vi.fn()}));
vi.mock('@components/animationIntersector', () => ({default: {addAnimation: vi.fn()}}));
vi.mock('@lib/lottie/lottieLoader', () => ({default: {loadLottieWorkers: vi.fn(), loadAnimationWorker: vi.fn()}}));
vi.mock('@components/wrappers/stickerAppearance', () => ({
  default: mocks.createStickerAppearance,
  onAnimationEnd: vi.fn()
}));

describe('wrapSticker render cancellation handling', () => {
  beforeEach(() => {
    mocks.getCacheContext.mockReset();
    mocks.downloadMediaURL.mockReset();
    mocks.createStickerAppearance.mockClear();
    mocks.getCacheContext.mockReturnValue({downloaded: true, url: undefined});
  });

  afterEach(() => vi.restoreAllMocks());

  it('ignores cancellation and logs unexpected fire-and-forget sticker failures', () => {
    const failure = new Error('sticker load failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => handleStickerError({type: 'MIDDLEWARE'})).not.toThrow();
    expect(() => handleStickerError(failure)).not.toThrow();
    expect(log).toHaveBeenCalledWith(failure);
  });

  it('returns the observed render promise to its callers and load promise list', async() => {
    const failure = new Error('media load failed');
    mocks.downloadMediaURL.mockRejectedValue(failure);
    const loadPromises: Promise<unknown>[] = [];
    const result = await wrapSticker({
      doc: {id: '42', attributes: [], thumbs: [], w: 32, h: 32} as any,
      div: document.createElement('div'),
      middleware: (() => true) as any,
      managers: {} as any,
      width: 24,
      height: 24,
      needFadeIn: false,
      loadPromises
    });

    expect(loadPromises[0]).toBe(result.render);
    await expect(result.render).rejects.toBe(failure);
  });

  it('preserves middleware cancellation through both render handles', async() => {
    mocks.downloadMediaURL.mockRejectedValue({type: 'MIDDLEWARE'});
    const loadPromises: Promise<unknown>[] = [];
    const result = await wrapSticker({
      doc: {id: '42', attributes: [], thumbs: [], w: 32, h: 32} as any,
      div: document.createElement('div'),
      middleware: (() => true) as any,
      managers: {} as any,
      width: 24,
      height: 24,
      needFadeIn: false,
      loadPromises
    });

    expect(loadPromises[0]).toBe(result.render);
    await expect(result.render).rejects.toMatchObject({type: 'MIDDLEWARE'});
  });
});
