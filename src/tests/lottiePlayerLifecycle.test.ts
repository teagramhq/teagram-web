import makeError from '@helpers/makeError';
import LottiePlayer from '@lib/lottie/lottiePlayer';

describe('LottiePlayer lifecycle', () => {
  it('cancels a delayed fallback frame before removal closes its bitmap', async() => {
    vi.useFakeTimers();

    class FakeImageBitmap {
      public width = 1;
      public height = 1;
      public detached = false;

      public close() {
        this.detached = true;
      }
    }

    vi.stubGlobal('ImageBitmap', FakeImageBitmap);

    const bitmap = new FakeImageBitmap();
    const drawImage = vi.fn((source: FakeImageBitmap) => {
      if(source.detached) {
        throw new DOMException('The image source is detached', 'InvalidStateError');
      }
    });
    const context = {
      canvas: {width: 1, height: 1},
      clearRect: vi.fn(),
      drawImage
    } as any;
    const player = Object.assign(Object.create(LottiePlayer.prototype), {
      autoplay: true,
      cache: {frames: new Map(), framesNew: new Map()},
      cachingDelta: Infinity,
      contexts: [context],
      destroyed: false,
      frInterval: 100,
      frThen: Date.now() + 50,
      offscreen: false,
      offscreenViaCompositor: false,
      paused: true
    }) as LottiePlayer;
    (player as any).sendQuery = vi.fn().mockResolvedValue(undefined);
    (player as any).dispatchEvent = vi.fn();
    (player as any).cleanup = vi.fn();
    (player as any).fail = vi.fn();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let renderedClosedBitmap = false;
    let loggedError = false;
    try {
      player.renderFrame(bitmap as unknown as ImageBitmap, 1);
      expect(vi.getTimerCount()).toBe(1);
      bitmap.close();
      player.remove();
      await vi.runAllTimersAsync();
      renderedClosedBitmap = drawImage.mock.calls.length > 0;
      loggedError = consoleError.mock.calls.length > 0;
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }

    expect(renderedClosedBitmap).toBe(false);
    expect(loggedError).toBe(false);
  });

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
