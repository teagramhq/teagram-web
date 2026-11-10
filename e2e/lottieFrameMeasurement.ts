import type {Locator, Page} from '@playwright/test';
import {PNG} from 'pngjs';

const BG = {r: 255, g: 0, b: 255};
const RENDERED_FRACTION = 0.005;

export const LOTTIE_FRAME_BG_CSS = `rgb(${BG.r},${BG.g},${BG.b})`;

function nonBackgroundFraction(png: Buffer): number {
  const {data, width, height} = PNG.sync.read(png);
  let differing = 0;
  for(let i = 0; i < data.length; i += 4) {
    const delta = Math.abs(data[i] - BG.r) + Math.abs(data[i + 1] - BG.g) + Math.abs(data[i + 2] - BG.b);
    if(delta > 40) ++differing;
  }
  return differing / (width * height);
}

// Detect the first actual on-screen pixels in the sticker's container.
export async function waitUntilOnScreen(page: Page, locator: Locator, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    if(nonBackgroundFraction(await locator.screenshot()) >= RENDERED_FRACTION) {
      return page.evaluate(() => performance.now());
    }
  }
  return null;
}

export async function waitForFirstStickerFrame(page: Page, timeoutMs: number): Promise<number> {
  await page.waitForFunction(() => Number.isFinite((window as any).__performanceFirstStickerFrameAt), undefined, {
    polling: 'raf',
    timeout: timeoutMs
  });
  return page.evaluate(() => (window as any).__performanceFirstStickerFrameAt as number);
}

export type FirstStickerPaintTiming = {
  workerRequestAt: number,
  firstFrameAt: number,
  nextPaintAt: number
};

export async function waitForFirstStickerPaint(page: Page, timeoutMs: number): Promise<FirstStickerPaintTiming> {
  await page.waitForFunction(() => {
    const timing = (window as any).__performanceFirstStickerPaintTiming;
    return Number.isFinite(timing?.workerRequestAt) && Number.isFinite(timing?.firstFrameAt) && Number.isFinite(timing?.nextPaintAt);
  }, undefined, {polling: 'raf', timeout: timeoutMs});
  return page.evaluate(() => (window as any).__performanceFirstStickerPaintTiming as FirstStickerPaintTiming);
}
