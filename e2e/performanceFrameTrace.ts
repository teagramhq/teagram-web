import type {CDPSession, Page} from '@playwright/test';

type Interval = {startMs: number, endMs: number};
type PageClockSample = {beforeTimestampUs: number, pageTimestampMs: number, afterTimestampUs: number};
type PageClockCalibration = {offsetMs: number, uncertaintyMs: number};
type PresentedFrameActivityWindows = {presentedFrameWindows: Interval[], expectedDropWindows: Interval[]};
type FrameTraceEvent = {name: string, startMs: number, durationMs: number, detail?: string};
type Span = {name: string, startMs: number, syncMs: number};
type PresentedFrameTrace = {
  session: CDPSession,
  page: Page,
  startTimestampUs: number,
  pageClockCalibration: PageClockCalibration,
  trackScrollActivity: boolean
};
type PresentedFrameTraceEvent = {name: string, cat?: string, ts: number};
type PresentedFrameDrainResult =
  | {ok: true, counts: ReturnType<typeof summarizePresentedFrameDrops>}
  | {ok: false, error: unknown};

class PresentedFrameCleanupError extends Error {
  constructor(readonly errors: unknown[]) {
    super('scenario and presented-frame cleanup failed');
    this.name = 'PresentedFrameCleanupError';
  }
}

const PRESENTED_FRAME_INTERVAL_MS = 1000 / 60;
const PRESENTED_FRAME_ACTIVITY_KEY = '__teagramPresentedFrameActivity';
const PRESENTED_FRAME_ACTIVITY_IDLE_MS = 100;
const PAGE_CLOCK_CALIBRATION_SAMPLES = 2;

export function summarizeFrameScripts(intervals: Interval[], frames: Array<{
  startTime: number, duration: number,
  scripts: Array<{executionStart: number, duration: number, sourceURL: string, sourceFunctionName: string}>
}>) {
  return intervals.map(({startMs, endMs}) => ({
    startMs,
    endMs,
    scripts: frames.filter((frame) => frame.startTime < endMs && frame.startTime + frame.duration > startMs)
    .flatMap((frame) => frame.scripts.filter((script) => script.executionStart < endMs && script.executionStart + script.duration > startMs)
    .map((script) => ({
      functionName: script.sourceFunctionName || '(anonymous)',
      script: script.sourceURL ? new URL(script.sourceURL, 'https://trace.invalid').pathname : '/native',
      startMs: script.executionStart,
      durationMs: script.duration
    })))
  }));
}

export function summarizeDroppedFrames(_intervals: Interval[], _events: FrameTraceEvent[], _spans: Span[]) {
  return _intervals.flatMap(({startMs, endMs}) => {
    const droppedFrames = Math.max(0, Math.round((endMs - startMs) / (1000 / 60)) - 1);
    if(!droppedFrames) return [];
    return [{
      startMs,
      endMs,
      droppedFrames,
      events: _events.filter((event) => event.startMs < endMs && event.startMs + event.durationMs > startMs),
      spans: _spans.filter((span) => span.startMs < endMs && span.startMs + span.syncMs > startMs)
    }];
  });
}

const markName = 'teagram-scroll-frame-trace-anchor';

export async function startFrameTrace(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing,v8',
    transferMode: 'ReturnAsStream'
  });
  const anchorMs = await page.evaluate((name) => {
    performance.clearMarks(name);
    performance.mark(name);
    return performance.getEntriesByName(name, 'mark')[0].startTime;
  }, markName);
  return {session, anchorMs};
}

async function readMonotonicTimestampUs(session: CDPSession) {
  const {metrics} = await session.send('Performance.getMetrics');
  const timestamp = (metrics as Array<{name: string, value: number}>).find(({name}) => name === 'Timestamp')?.value;
  if(!Number.isFinite(timestamp)) throw new Error('CDP performance metrics are missing the monotonic timestamp');
  return timestamp * 1_000_000;
}

export function choosePageClockCalibration(samples: PageClockSample[]): PageClockCalibration {
  if(!samples.length) throw new Error('Page clock calibration requires at least one sample');
  const best = samples.reduce((best, sample, index) => {
    const beforeMs = sample.beforeTimestampUs / 1000;
    const afterMs = sample.afterTimestampUs / 1000;
    if(!Number.isFinite(beforeMs) || !Number.isFinite(afterMs) || !Number.isFinite(sample.pageTimestampMs) || afterMs < beforeMs) {
      throw new Error('Page clock calibration sample is invalid');
    }
    const roundTripMs = afterMs - beforeMs;
    if(index && roundTripMs >= best.roundTripMs) return best;
    return {
      offsetMs: (beforeMs + afterMs) / 2 - sample.pageTimestampMs,
      uncertaintyMs: roundTripMs / 2,
      roundTripMs
    };
  }, {offsetMs: 0, uncertaintyMs: 0, roundTripMs: Infinity});
  return {offsetMs: best.offsetMs, uncertaintyMs: best.uncertaintyMs};
}

export function toTraceActivityWindows(windows: Interval[], {offsetMs, uncertaintyMs}: PageClockCalibration): PresentedFrameActivityWindows {
  const presentedFrameWindows: Interval[] = [];
  const expectedDropWindows: Interval[] = [];
  windows.forEach(({startMs, endMs}) => {
    presentedFrameWindows.push({
      startMs: startMs + offsetMs - uncertaintyMs - PRESENTED_FRAME_INTERVAL_MS,
      endMs: endMs + offsetMs + uncertaintyMs + PRESENTED_FRAME_INTERVAL_MS
    });
    const expectedStartMs = startMs + offsetMs + uncertaintyMs;
    const expectedEndMs = endMs + offsetMs - uncertaintyMs;
    if(expectedEndMs > expectedStartMs) expectedDropWindows.push({startMs: expectedStartMs, endMs: expectedEndMs});
  });
  return {presentedFrameWindows, expectedDropWindows};
}

export function summarizePresentedFrameDrops(timestampsMs: number[], presentedFrameWindows?: Interval[], expectedDropWindows = presentedFrameWindows) {
  const frames = [...new Set(timestampsMs.filter(Number.isFinite))].sort((left, right) => left - right);
  const isPresentedFrameActive = (timestampMs: number) => presentedFrameWindows === undefined || presentedFrameWindows.some(({startMs, endMs}) => timestampMs >= startMs && timestampMs <= endMs);
  const isExpectedDropActive = (timestampMs: number) => expectedDropWindows === undefined || expectedDropWindows.some(({startMs, endMs}) => timestampMs >= startMs && timestampMs <= endMs);
  let presentedDropped = 0;
  let presentedFrames = 0;
  frames.forEach((frame) => {
    if(isPresentedFrameActive(frame)) ++presentedFrames;
  });
  for(let index = 1; index < frames.length; ++index) {
    const elapsedIntervals = Math.round((frames[index] - frames[index - 1]) / PRESENTED_FRAME_INTERVAL_MS);
    for(let interval = 1; interval < elapsedIntervals; ++interval) {
      const expectedPresentationMs = frames[index - 1] + interval * PRESENTED_FRAME_INTERVAL_MS;
      if(isExpectedDropActive(expectedPresentationMs)) ++presentedDropped;
    }
  }
  return {presentedFrames, presentedDropped};
}

async function startPresentedFrameActivityCapture(page: Page) {
  return page.evaluate(({key, idleMs}) => {
    const scrollable = document.querySelector<HTMLElement>('.bubbles-scrollable');
    if(!scrollable) throw new Error('Presented-frame activity tracking requires the scroll container');
    const activity = window as any;
    if(activity[key]) throw new Error('Presented-frame activity tracking is already active');
    const windows: Interval[] = [];
    let activeStartMs: number | undefined;
    let idleTimer: number | undefined;
    let lastActivityMs = 0;
    const close = () => {
      if(activeStartMs === undefined) return;
      windows.push({startMs: activeStartMs, endMs: performance.now()});
      activeStartMs = undefined;
    };
    const scheduleIdleClose = (delayMs: number) => {
      idleTimer = window.setTimeout(() => {
        idleTimer = undefined;
        const remainingMs = idleMs - (performance.now() - lastActivityMs);
        if(remainingMs > 0) {
          scheduleIdleClose(remainingMs);
          return;
        }
        close();
      }, delayMs);
    };
    const recordActivity = () => {
      const activityMs = performance.now();
      if(activeStartMs === undefined) activeStartMs = activityMs;
      lastActivityMs = activityMs;
      if(idleTimer === undefined) scheduleIdleClose(idleMs);
    };
    const onWheel = (event: Event) => {
      const target = event.target;
      if(target instanceof Node && scrollable.contains(target)) recordActivity();
    };
    const onScroll = (event: Event) => {
      if(event.target === scrollable) recordActivity();
    };
    const onScrollEnd = (event: Event) => {
      if(event.target !== scrollable) return;
      if(idleTimer !== undefined) window.clearTimeout(idleTimer);
      idleTimer = undefined;
      close();
    };
    scrollable.addEventListener('wheel', onWheel, {capture: true, passive: true});
    scrollable.addEventListener('scroll', onScroll, {capture: true, passive: true});
    scrollable.addEventListener('scrollend', onScrollEnd, true);
    activity[key] = {
      finish: () => {
        if(idleTimer !== undefined) window.clearTimeout(idleTimer);
        idleTimer = undefined;
        close();
        scrollable.removeEventListener('wheel', onWheel, true);
        scrollable.removeEventListener('scroll', onScroll, true);
        scrollable.removeEventListener('scrollend', onScrollEnd, true);
        delete activity[key];
        return windows;
      }
    };
  }, {key: PRESENTED_FRAME_ACTIVITY_KEY, idleMs: PRESENTED_FRAME_ACTIVITY_IDLE_MS});
}

async function stopPresentedFrameActivityCapture(page: Page) {
  return page.evaluate((key) => {
    const activity = (window as any)[key];
    if(!activity) throw new Error('Presented-frame activity tracking is not active');
    return activity.finish() as Interval[];
  }, PRESENTED_FRAME_ACTIVITY_KEY);
}

async function calibratePageClock(session: CDPSession, page: Page, initialBeforeTimestampUs: number): Promise<PageClockCalibration> {
  const samples: PageClockSample[] = [];
  let beforeTimestampUs = initialBeforeTimestampUs;
  for(let index = 0; index < PAGE_CLOCK_CALIBRATION_SAMPLES; ++index) {
    const pageTimestampMs = await page.evaluate(() => performance.now());
    const afterTimestampUs = await readMonotonicTimestampUs(session);
    samples.push({beforeTimestampUs, pageTimestampMs, afterTimestampUs});
    beforeTimestampUs = afterTimestampUs;
  }
  return choosePageClockCalibration(samples);
}

export async function startPresentedFrameCapture(page: Page, options: {trackScrollActivity?: boolean} = {}): Promise<PresentedFrameTrace> {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  await session.send('Tracing.start', {categories: 'disabled-by-default-display.framedisplayed,-*', transferMode: 'ReturnAsStream'});
  try {
    const startTimestampUs = await readMonotonicTimestampUs(session);
    const pageClockCalibration = await calibratePageClock(session, page, startTimestampUs);
    if(options.trackScrollActivity) await startPresentedFrameActivityCapture(page);
    return {
      session,
      page,
      startTimestampUs,
      pageClockCalibration,
      trackScrollActivity: options.trackScrollActivity === true
    };
  } catch(error) {
    await session.detach();
    throw error;
  }
}

export async function endPresentedFrameCapture({session, page, startTimestampUs, pageClockCalibration, trackScrollActivity}: PresentedFrameTrace) {
  const pageActivityWindows = trackScrollActivity ? await stopPresentedFrameActivityCapture(page) : undefined;
  const activityWindows = pageActivityWindows && toTraceActivityWindows(pageActivityWindows, pageClockCalibration);
  const endTimestampUs = await readMonotonicTimestampUs(session);
  const completed = new Promise<string>((resolve) => session.once('Tracing.tracingComplete', ({stream}) => resolve(stream!)));
  const endCommand = session.send('Tracing.end');
  const captureResult = (async(): Promise<ReturnType<typeof summarizePresentedFrameDrops>> => {
    try {
      await endCommand;
      const stream = await completed;
      let data = '';
      for(;;) {
        const part = await session.send('IO.read', {handle: stream, size: 1_048_576});
        data += part.base64Encoded ? Buffer.from(part.data, 'base64').toString('utf8') : part.data;
        if(part.eof) break;
      }
      await session.send('IO.close', {handle: stream});
      const trace = JSON.parse(data) as {traceEvents: PresentedFrameTraceEvent[]};
      const timestampsMs = trace.traceEvents.filter((event) => {
        const categories = event.cat?.split(',') || [];
        return event.name === 'Display::FrameDisplayed' && categories.includes('disabled-by-default-display.framedisplayed') &&
          event.ts >= startTimestampUs && event.ts <= endTimestampUs;
      }).map((event) => event.ts / 1000);
      return summarizePresentedFrameDrops(timestampsMs, activityWindows?.presentedFrameWindows, activityWindows?.expectedDropWindows);
    } finally {
      await session.detach();
    }
  })();
  const result = captureResult.then(
    (counts): PresentedFrameDrainResult => ({ok: true, counts}),
    (error: unknown): PresentedFrameDrainResult => ({ok: false, error})
  );
  return {result};
}

export async function stopPresentedFrameCapture(trace: PresentedFrameTrace) {
  const {result} = await endPresentedFrameCapture(trace);
  const outcome = await result;
  if(outcome.ok === false) throw outcome.error;
  return outcome.counts;
}

export async function withPresentedFrameCleanup<T>(run: () => Promise<T>, drain: () => Promise<void>, close: () => Promise<void>): Promise<T> {
  let runFailed = false;
  let runError: unknown;
  try {
    return await run();
  } catch(error) {
    runFailed = true;
    runError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await drain();
    } catch(error) {
      cleanupErrors.push(error);
    }
    try {
      await close();
    } catch(error) {
      cleanupErrors.push(error);
    }
    if(cleanupErrors.length) {
      const errors = runFailed ? [runError, ...cleanupErrors] : cleanupErrors;
      if(errors.length === 1) throw errors[0];
      throw new PresentedFrameCleanupError(errors);
    }
  }
}

export async function stopFrameTrace({session, anchorMs}: Awaited<ReturnType<typeof startFrameTrace>>): Promise<FrameTraceEvent[]> {
  const completed = new Promise<string>((resolve) => session.once('Tracing.tracingComplete', ({stream}) => resolve(stream!)));
  await session.send('Tracing.end');
  const stream = await completed;
  let data = '';
  for(;;) {
    const part = await session.send('IO.read', {handle: stream});
    data += part.base64Encoded ? Buffer.from(part.data, 'base64').toString('utf8') : part.data;
    if(part.eof) break;
  }
  await session.send('IO.close', {handle: stream});
  await session.detach();
  const trace = JSON.parse(data) as {traceEvents: Array<{
    name: string, ph: string, pid: number, tid: number, ts: number, dur?: number,
    args?: {data?: {functionName?: string, url?: string}}
  }>};
  const anchor = trace.traceEvents.find((event) => event.name === markName);
  if(!anchor) throw new Error('Frame trace is missing its page clock anchor');
  const names = new Set(['FunctionCall', 'EvaluateScript', 'EventDispatch', 'FireAnimationFrame', 'TimerFire',
    'UpdateLayoutTree', 'Layout', 'RecalculateStyles', 'MinorGC', 'MajorGC']);
  return trace.traceEvents.filter((event) => event.pid === anchor.pid && event.tid === anchor.tid &&
    event.ph === 'X' && !!event.dur && (names.has(event.name) || event.name.startsWith('V8.GC'))).map((event) => ({
    name: event.name,
    startMs: anchorMs + (event.ts - anchor.ts) / 1000,
    durationMs: event.dur! / 1000,
    ...(event.args?.data?.functionName || event.args?.data?.url ? {
      detail: [event.args.data.functionName, event.args.data.url && new URL(event.args.data.url, 'https://trace.invalid').pathname].filter(Boolean).join(' ')
    } : {})
  }));
}
