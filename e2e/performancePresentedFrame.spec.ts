import * as performanceFrameTrace from './performanceFrameTrace';
import {expect, test} from '@playwright/test';

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
