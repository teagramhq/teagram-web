import type {Page} from '@playwright/test';

type Interval = {startMs: number, endMs: number};
type Event = {name: string, startMs: number, durationMs: number, detail?: string};
type Span = {name: string, startMs: number, syncMs: number};

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

export function summarizeDroppedFrames(_intervals: Interval[], _events: Event[], _spans: Span[]) {
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

export async function stopFrameTrace({session, anchorMs}: Awaited<ReturnType<typeof startFrameTrace>>): Promise<Event[]> {
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
