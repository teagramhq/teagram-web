import {expect, test} from '@playwright/test';
import {evaluatePerformance, SCENARIOS} from '../scripts/performance/policy.mjs';

test('100 ms main-thread negative control is detected and blocks the gate', async({page}) => {
  await page.goto('data:text/html,<title>performance negative control</title>');
  const observation = await page.evaluate(async() => {
    const entries: number[] = [];
    const observer = new PerformanceObserver((list) => {
      entries.push(...list.getEntries().map((entry) => entry.duration));
    });
    observer.observe({type: 'longtask', buffered: true});
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const started = performance.now();
    while(performance.now() - started < 100) {}
    const blockedFor = performance.now() - started;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    entries.push(...observer.takeRecords().map((entry) => entry.duration));
    observer.disconnect();
    return {supported: PerformanceObserver.supportedEntryTypes, blockedFor, entries};
  });

  expect(observation.blockedFor).toBeGreaterThanOrEqual(100);
  expect(observation.entries.some((duration) => duration > 50)).toBe(true);
  const sample = (longTasksOver50Ms: number) => ({
    ms: 1,
    requests: 0,
    domNodes: 1,
    bundleBytes: 0,
    longTasksOver50Ms,
    droppedFramePercent: 0
  });
  const samples = Object.fromEntries(SCENARIOS.map(({key}) => [key, [
    sample(key === 'scrollBack2k' ? 1 : 0),
    sample(key === 'scrollBack2k' ? 1 : 0)
  ]]));
  const result = evaluatePerformance({variants: {head: {'1x': samples, '100x': samples}}});
  expect(result.blockingFailures.some((failure) => failure.includes('scrollBack2k') && failure.includes('long task'))).toBe(true);
});
