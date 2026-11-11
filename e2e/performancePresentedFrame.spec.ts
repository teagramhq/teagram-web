import * as performanceFrameTrace from './performanceFrameTrace';
import {expect, test} from '@playwright/test';

test('counts missed presentations during activity but ignores idle gaps on pause and resume', () => {
  const summarize = (performanceFrameTrace as any).summarizePresentedFrameDrops;
  expect(typeof summarize, 'presented-frame summary must be available').toBe('function');
  if(typeof summarize !== 'function') return;

  const result = summarize(
    [0, 50, 1_050, 1_100],
    [{startMs: 0, endMs: 50}, {startMs: 1_050, endMs: 1_100}]
  );

  expect(result.presentedFrames).toBe(4);
  expect(result.presentedDropped, 'the one-second idle pause between bursts is not a missed-frame interval').toBe(4);
});

test('does not count the idle pause between wheel-driven scroll bursts', async({page}) => {
  const startCapture = (performanceFrameTrace as any).startPresentedFrameCapture;
  const stopCapture = (performanceFrameTrace as any).stopPresentedFrameCapture;
  expect(typeof startCapture, 'presented-frame capture must be available').toBe('function');
  expect(typeof stopCapture, 'presented-frame capture must be available').toBe('function');
  if(typeof startCapture !== 'function' || typeof stopCapture !== 'function') return;

  await page.setContent('<div class="bubbles-scrollable" style="height:100px;width:100px;overflow:auto"><div style="height:1000px;width:100px;background:linear-gradient(black,white)"></div></div>');
  const scrollable = page.locator('.bubbles-scrollable');
  const bounds = await scrollable.boundingBox();
  expect(bounds).toBeTruthy();
  const capture = await startCapture(page, {trackScrollActivity: true});
  await page.mouse.move(bounds!.x + 20, bounds!.y + 20);

  for(let burst = 0; burst < 2; ++burst) {
    const previousScrollTop = await scrollable.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => scrollable.evaluate((element) => element.scrollTop)).toBeGreaterThan(previousScrollTop);
    if(burst === 0) await page.waitForTimeout(1_000);
  }

  const result = await stopCapture(capture);
  expect(result.presentedFrames).toBeGreaterThanOrEqual(2);
  expect(result.presentedDropped, 'the one-second pause between damage bursts is idle, not 60 dropped frames').toBeLessThan(10);
});

test('counts a fixed 60 Hz animation within three presented frames', async({page}) => {
  const startCapture = (performanceFrameTrace as any).startPresentedFrameCapture;
  const stopCapture = (performanceFrameTrace as any).stopPresentedFrameCapture;
  expect(typeof startCapture, 'presented-frame capture must be available').toBe('function');
  expect(typeof stopCapture, 'presented-frame capture must be available').toBe('function');
  if(typeof startCapture !== 'function' || typeof stopCapture !== 'function') return;

  await page.setContent('<div id="animated" style="width:20px;height:20px;background:black"></div>');
  const capture = await startCapture(page);
  await page.evaluate(async() => {
    const animated = document.querySelector<HTMLElement>('#animated')!;
    const startedAt = performance.now();
    await new Promise<void>((resolve) => requestAnimationFrame(function animate(time) {
      animated.style.transform = `translateX(${(time - startedAt) % 120}px)`;
      if(time - startedAt < 1_000) requestAnimationFrame(animate);
      else resolve();
    }));
  });

  const result = await stopCapture(capture);
  expect(result.presentedFrames, 'one second at 60 Hz is 60 frames ±3').toBeGreaterThanOrEqual(57);
  expect(result.presentedFrames, 'one second at 60 Hz is 60 frames ±3').toBeLessThanOrEqual(63);
  expect(result.presentedDropped, 'a fixed-rate animation should have at most two missed presentations').toBeLessThanOrEqual(2);
});

test('reports both scenario and trace-drain failures while still closing the context', async() => {
  const withCleanup = (performanceFrameTrace as any).withPresentedFrameCleanup;
  expect(typeof withCleanup, 'presented-frame cleanup must be available').toBe('function');
  if(typeof withCleanup !== 'function') return;

  const scenarioError = new Error('scenario failed');
  const drainError = new Error('trace drain failed');
  let contextClosed = false;
  let thrown: unknown;
  try {
    await withCleanup(
      async() => { throw scenarioError; },
      async() => { throw drainError; },
      async() => { contextClosed = true; }
    );
  } catch(error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error & {errors: unknown[]}).errors).toEqual([scenarioError, drainError]);
  expect(contextClosed, 'context closure must run after a drain failure').toBe(true);
});
