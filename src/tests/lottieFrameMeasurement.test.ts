import {expect, it, vi} from 'vitest';
import type {Locator, Page} from '@playwright/test';
import {PNG} from 'pngjs';
import {waitForFirstStickerPaint, waitUntilOnScreen} from '../../e2e/lottieFrameMeasurement';

it('waits for the worker request, first frame, and following paint timestamps in the page', async() => {
  const timing: Record<string, number | undefined> = {workerRequestAt: 12, firstFrameAt: 410};
  vi.stubGlobal('window', {__performanceFirstStickerPaintTiming: timing});
  let waitCount = 0;
  const page = {
    waitForFunction: async(predicate: () => boolean, _argument: unknown, options: {polling: string, timeout: number}) => {
      ++waitCount;
      expect(options).toEqual({polling: 'raf', timeout: 1_000});
      expect(predicate()).toBe(false);
      timing.nextPaintAt = 426;
      expect(predicate()).toBe(true);
    },
    evaluate: async<T>(callback: () => T) => callback()
  } as unknown as Page;

  try {
    await expect(waitForFirstStickerPaint(page, 1_000)).resolves.toEqual({
      workerRequestAt: 12,
      firstFrameAt: 410,
      nextPaintAt: 426
    });
    expect(waitCount).toBe(1);
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

  await expect(waitUntilOnScreen(page, locator, 100)).resolves.toBe(42);
  expect(events).toEqual(['screenshot', 'timestamp']);
});
