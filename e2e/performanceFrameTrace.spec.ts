import {expect, test} from '@playwright/test';
import {startFrameTrace, stopFrameTrace, summarizeDroppedFrames, summarizeFrameScripts} from './performanceFrameTrace';

test('matches dropped intervals to overlapping renderer work and history spans', () => {
  const result = summarizeDroppedFrames(
    [{startMs: 10, endMs: 43.4}, {startMs: 43.4, endMs: 60}],
    [
      {name: 'FunctionCall', startMs: 15, durationMs: 10, detail: 'render'},
      {name: 'Layout', startMs: 26, durationMs: 5},
      {name: 'MinorGC', startMs: 32, durationMs: 3},
      {name: 'FunctionCall', startMs: 50, durationMs: 2}
    ],
    [{name: 'bubbles.processBatch', startMs: 17, syncMs: 4}]
  );
  expect(result).toHaveLength(1);
  expect(result[0].droppedFrames).toBe(1);
  expect(result[0].events.map((event) => event.name)).toEqual(['FunctionCall', 'Layout', 'MinorGC']);
  expect(result[0].spans.map((span) => span.name)).toEqual(['bubbles.processBatch']);
});

test('retains dropped intervals even when no renderer work was recorded', () => {
  expect(summarizeDroppedFrames([{startMs: 0, endMs: 50}], [], [])).toEqual([{
    startMs: 0, endMs: 50, droppedFrames: 2, events: [], spans: []
  }]);
});

test('keeps short scripts from long animation frames overlapping a dropped interval', () => {
  const frames = [{startTime: 5, duration: 60, scripts: [
    {executionStart: 12, duration: 8, sourceURL: 'https://example.test/app.js?secret=1', sourceFunctionName: 'render'},
    {executionStart: 50, duration: 10, sourceURL: '', sourceFunctionName: 'later'}
  ]}];
  expect(summarizeFrameScripts([{startMs: 10, endMs: 40}], frames)).toEqual([{
    startMs: 10, endMs: 40,
    scripts: [{functionName: 'render', script: '/app.js', startMs: 12, durationMs: 8}]
  }]);
});

test('collects sub-50ms script and layout work from the measured browser', async({page}) => {
  await page.setContent('<div id="target"></div>');
  const profiler = await page.context().newCDPSession(page);
  await profiler.send('Profiler.enable');
  await profiler.send('Profiler.start');
  const trace = await startFrameTrace(page);
  const interval = await page.evaluate(() => new Promise<{startMs: number, endMs: number}>((resolve) => setTimeout(() => {
    const startMs = performance.now();
    const target = document.getElementById('target')!;
    target.style.width = '123px';
    target.getBoundingClientRect();
    const until = performance.now() + 20;
    while(performance.now() < until) {}
    resolve({startMs, endMs: performance.now()});
  }, 0)));
  const {profile} = await profiler.send('Profiler.stop');
  await profiler.detach();
  const events = await stopFrameTrace(trace);
  const matches = events.filter((event) => event.startMs < interval.endMs && event.startMs + event.durationMs > interval.startMs);
  expect(matches.some((event) => event.name === 'Layout')).toBe(true);
  expect(matches.some((event) => event.name === 'FunctionCall' || event.name === 'EvaluateScript')).toBe(true);
  expect(profile.samples!.length).toBeGreaterThan(0);
});
