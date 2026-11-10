import {expect, it, vi} from 'vitest';
import type {Locator, Page} from '@playwright/test';
import {PNG} from 'pngjs';
import * as frameMeasurement from '../../e2e/lottieFrameMeasurement';

it('waits for the endpoint after an intervening paint and later frame work', async() => {
  const timing: Record<string, number | undefined> = {workerRequestAt: 12, firstFrameAt: 410};
  vi.stubGlobal('window', {__performanceFirstStickerPaintTiming: timing});
  const frameCallbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  });
  const events: string[] = [];
  let waitCount = 0;
  const page = {
    waitForFunction: async(predicate: () => boolean, _argument: unknown, options: {polling: string, timeout: number}) => {
      ++waitCount;
      expect(options).toEqual({polling: 'raf', timeout: 1_000});
      expect(predicate()).toBe(false);
      const scheduleAfterInterveningPaint = (frameMeasurement as unknown as {
        scheduleAfterInterveningPaint?: (callback: FrameRequestCallback) => void
      }).scheduleAfterInterveningPaint;
      expect(scheduleAfterInterveningPaint).toEqual(expect.any(Function));
      if(!scheduleAfterInterveningPaint) return;
      events.push('first-frame');
      scheduleAfterInterveningPaint((timestamp) => {
        timing.nextPaintAt = timestamp;
        events.push('endpoint');
      });
      expect(frameCallbacks).toHaveLength(1);
      frameCallbacks.shift()?.(416);
      expect(predicate()).toBe(false);
      events.push('intervening-paint');
      events.push('later-frame-work');
      expect(frameCallbacks).toHaveLength(1);
      frameCallbacks.shift()?.(458);
      expect(predicate()).toBe(true);
    },
    evaluate: async<T>(callback: () => T) => callback()
  } as unknown as Page;

  try {
    await expect(frameMeasurement.waitForFirstStickerPaint(page, 1_000)).resolves.toEqual({
      workerRequestAt: 12,
      firstFrameAt: 410,
      nextPaintAt: 458
    });
    expect(waitCount).toBe(1);
    expect(events).toEqual(['first-frame', 'intervening-paint', 'later-frame-work', 'endpoint']);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('samples the timestamp after the screenshot observes rendered pixels', async() => {
  const events: string[] = [];
  const png = new PNG({width: 4, height: 4});
  const data = png.data;
  for(let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 0;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  data[0] = 0;

  const page = {
    evaluate: async() => {
      events.push('timestamp');
      return 42;
    }
  } as unknown as Page;
  const locator = {
    screenshot: async() => {
      events.push('screenshot');
      return PNG.sync.write(png);
    }
  } as unknown as Locator;

  await expect(frameMeasurement.waitUntilOnScreen(page, locator, 100)).resolves.toBe(42);
  expect(events).toEqual(['screenshot', 'timestamp']);
});
