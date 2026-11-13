import * as performanceFrameTrace from './performanceFrameTrace';
import {expect, test} from '@playwright/test';

test('counts missed presentations during activity but ignores idle gaps on pause and resume', () => {
  const summarize = (performanceFrameTrace as any).summarizePresentedFrameDrops;
  const calibrate = (performanceFrameTrace as any).choosePageClockCalibration;
  const toTraceWindows = (performanceFrameTrace as any).toTraceActivityWindows;
  expect(typeof summarize, 'presented-frame summary must be available').toBe('function');
  expect(typeof calibrate, 'page clock calibration must be available').toBe('function');
  expect(typeof toTraceWindows, 'activity windows must use the production clock conversion').toBe('function');
  if(typeof summarize !== 'function' || typeof calibrate !== 'function' || typeof toTraceWindows !== 'function') return;

  const calibration = calibrate([
    {beforeTimestampUs: 1_000_000, pageTimestampMs: 50, afterTimestampUs: 1_050_000},
    {beforeTimestampUs: 1_099_000, pageTimestampMs: 100, afterTimestampUs: 1_101_000}
  ]);
  expect(calibration, 'the 50 ms delayed clock sample must not bias the chosen offset').toEqual({offsetMs: 1_000, uncertaintyMs: 1});

  const activityWindows = toTraceWindows(
    [{startMs: 0, endMs: 50}, {startMs: 1_050, endMs: 1_100}],
    calibration
  );
  expect(activityWindows.expectedDropWindows).toEqual([{startMs: 1_001, endMs: 1_049}, {startMs: 2_051, endMs: 2_099}]);
  expect(activityWindows.presentedFrameWindows[0].startMs).toBeLessThan(activityWindows.expectedDropWindows[0].startMs);
  expect(activityWindows.presentedFrameWindows[0].endMs).toBeGreaterThan(activityWindows.expectedDropWindows[0].endMs);

  const result = summarize(
    [1_002, 1_048, 2_052, 2_098],
    activityWindows.presentedFrameWindows,
    activityWindows.expectedDropWindows
  );

  expect(result.presentedFrames).toBe(4);
  expect(result.presentedDropped, 'clock uncertainty and window conversion must not make idle pause slots eligible').toBe(4);
});

test('page clock calibration stays bounded when one page command is delayed', async({page}) => {
  const startCapture = (performanceFrameTrace as any).startPresentedFrameCapture;
  const stopCapture = (performanceFrameTrace as any).stopPresentedFrameCapture;
  const chooseCalibration = (performanceFrameTrace as any).choosePageClockCalibration;
  expect(typeof startCapture, 'presented-frame capture must be available').toBe('function');
  expect(typeof stopCapture, 'presented-frame capture must be available').toBe('function');
  expect(typeof chooseCalibration, 'page clock calibration must be available').toBe('function');
  if(typeof startCapture !== 'function' || typeof stopCapture !== 'function' || typeof chooseCalibration !== 'function') return;

  const originalEvaluate = page.evaluate.bind(page) as (pageFunction: () => number) => Promise<number>;
  let delayed = false;
  let calibrationEvaluations = 0;
  (page as any).evaluate = async(pageFunction: () => number) => {
    ++calibrationEvaluations;
    if(!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return originalEvaluate(pageFunction);
  };

  let capture: any;
  try {
    capture = await startCapture(page);
    expect(delayed, 'the first clock sample should include the injected command delay').toBe(true);
    expect(calibrationEvaluations, 'clock calibration should reuse the initial monotonic timestamp and use two bounded samples').toBe(2);

    const readTimestampUs = async() => {
      const {metrics} = await capture.session.send('Performance.getMetrics');
      return (metrics as Array<{name: string, value: number}>).find(({name}) => name === 'Timestamp')!.value * 1_000_000;
    };
    const beforeTimestampUs = await readTimestampUs();
    const pageTimestampMs = await originalEvaluate(() => performance.now());
    const afterTimestampUs = await readTimestampUs();
    const reference = chooseCalibration([{beforeTimestampUs, pageTimestampMs, afterTimestampUs}]);
    const calibration = capture.pageClockCalibration;

    expect(calibration.uncertaintyMs, 'a single slow sample must not become the selected calibration').toBeLessThan(50);
    expect(Math.abs(calibration.offsetMs - reference.offsetMs), 'the selected offset should agree with an independent bounded sample')
    .toBeLessThanOrEqual(calibration.uncertaintyMs + reference.uncertaintyMs + 1);
  } finally {
    (page as any).evaluate = originalEvaluate;
    if(capture) await stopCapture(capture);
  }
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
  expect(result.presentedDropped, 'padding around the damage bursts must not add idle gap slots').toBeLessThan(6);
});

test('does not reset the inactivity timer on each scroll event', async({page}) => {
  const startCapture = (performanceFrameTrace as any).startPresentedFrameCapture;
  const stopCapture = (performanceFrameTrace as any).stopPresentedFrameCapture;
  expect(typeof startCapture, 'presented-frame capture must be available').toBe('function');
  expect(typeof stopCapture, 'presented-frame capture must be available').toBe('function');
  if(typeof startCapture !== 'function' || typeof stopCapture !== 'function') return;

  await page.setContent('<div class="bubbles-scrollable" style="height:100px;width:100px;overflow:auto"><div style="height:1000px;width:100px"></div></div>');
  await page.evaluate(() => {
    const windowAny = window as any;
    const originalSetTimeout = window.setTimeout.bind(window);
    windowAny.__presentedFrameIdleTimerSchedules = 0;
    windowAny.setTimeout = (handler: any, delay?: number, ...args: any[]) => {
      if(delay === 100) ++windowAny.__presentedFrameIdleTimerSchedules;
      return originalSetTimeout(handler, delay, ...args);
    };
  });

  const capture = await startCapture(page, {trackScrollActivity: true});
  await page.evaluate(() => {
    const scrollable = document.querySelector<HTMLElement>('.bubbles-scrollable')!;
    scrollable.dispatchEvent(new WheelEvent('wheel', {bubbles: true}));
    for(let index = 0; index < 100; ++index) scrollable.dispatchEvent(new Event('scroll'));
  });
  const schedules = await page.evaluate(() => (window as any).__presentedFrameIdleTimerSchedules as number);
  await stopCapture(capture);

  expect(schedules, 'one inactivity timer should cover the whole active burst').toBe(1);
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
