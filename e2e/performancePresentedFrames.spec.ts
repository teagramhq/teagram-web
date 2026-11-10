import {expect, test, type Page} from '@playwright/test';
import {startPresentedFrameCapture, summarizePresentedFrameGaps} from './performancePresentedFrames';

test('counts compositor frame gaps only inside the measured scroll window', () => {
  const result = summarizePresentedFrameGaps([
    999,
    1_000,
    1_000 + 1_000 / 60,
    1_000 + 3_000 / 60,
    1_000 + 4_000 / 60,
    1_100,
    1_101
  ], 1_000, 1_075);

  expect(result.presentedFrames).toBe(4);
  expect(result.presentedDropped).toBe(1);
  expect(result.presentedDroppedPercent).toBe(20);
});

test('sorts frame swap timestamps before counting compositor gaps', () => {
  const result = summarizePresentedFrameGaps([
    1_000 + 4_000 / 60,
    1_000 + 3_000 / 60,
    1_000,
    1_000 + 1_000 / 60,
    1_000 + 5_000 / 60
  ], 1_000, 1_100);

  expect(result.presentedFrames).toBe(5);
  expect(result.presentedDropped).toBe(1);
});

test('fails capture when a compositor frame has no timestamp', async() => {
  type FrameEvent = {sessionId: number, metadata: {timestamp?: number}};
  let frameListener: ((event: FrameEvent) => void) | undefined;
  let acknowledgementCount = 0;
  const fakeSession = {
    on(_event: string, listener: (event: FrameEvent) => void) {
      frameListener = listener;
    },
    off(_event: string) {
      frameListener = undefined;
    },
    async send(method: string) {
      if(method === 'Page.startScreencast') frameListener?.({sessionId: 42, metadata: {}});
      if(method === 'Page.screencastFrameAck') acknowledgementCount += 1;
    },
    async detach() {}
  };
  const fakePage = {
    context: () => ({newCDPSession: async() => fakeSession})
  } as unknown as Page;
  const capture = await startPresentedFrameCapture(fakePage);

  await expect(capture.stop(0, 10)).rejects.toThrow('1 screencast frame(s) lacked a timestamp');
  expect(acknowledgementCount).toBe(1);
});

test('captures compositor frame swaps without a tracing or profiler session', async({page}) => {
  await page.setContent('<div id="frame" style="width:100px;height:100px;background:#000"></div>');
  const capture = await startPresentedFrameCapture(page);
  const window = await page.evaluate(async() => {
    const element = document.querySelector<HTMLElement>('#frame')!;
    const startedAt = performance.now();
    let frames = 0;
    await new Promise<void>((resolve) => {
      const paint = () => {
        element.style.transform = `translateX(${frames}px)`;
        frames += 1;
        if(frames === 20) resolve();
        else requestAnimationFrame(paint);
      };
      requestAnimationFrame(paint);
    });
    return {
      startMs: performance.timeOrigin + startedAt,
      endMs: performance.timeOrigin + performance.now()
    };
  });
  const result = await capture.stop(window.startMs, window.endMs);

  expect(result.presentedFrames).toBeGreaterThan(1);
});
