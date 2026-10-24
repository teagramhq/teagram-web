import makeError from '@helpers/makeError';
import LottiePlayer from '@lib/lottie/lottiePlayer';

describe('LottiePlayer lifecycle', () => {
  it('ignores a worker load rejection after destruction', async() => {
    const player = Object.assign(Object.create(LottiePlayer.prototype), {
      reqId: 1,
      workerId: 0,
      width: 1,
      height: 1,
      offscreen: 'canvas',
      offscreenViaCompositor: false,
      offscreenLoadFailed: false,
      offscreenCanvases: [],
      destroyed: false
    }) as LottiePlayer;
    const sendQuery = vi.fn().mockRejectedValue(makeError('ITEM_DESTROYED'));
    (player as any).sendQuery = sendQuery;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const load = player.loadFromData(new Blob(['animation']), 'lottie-wasm');
    player.destroyed = true;

    await expect(load).resolves.toBeUndefined();
    expect(sendQuery).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
