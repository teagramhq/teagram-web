import {readFileSync, writeFileSync} from 'node:fs';
import {expect, test, type Browser, type BrowserContext, type Page, type Request} from '@playwright/test';
import Icons from '../src/icons';
import {COLD_CHAT_LIST_REPEATS, evaluatePerformance, PERFORMANCE_MEASUREMENT_VERSION, PERFORMANCE_REPEATS, PERFORMANCE_TIMING_REPEATS} from '../scripts/performance/policy.mjs';
import {createBundleRequestTracker, sumBundleBytes, type BundleRequestTracker} from './performanceBundleBytes';
import {findLongTasksWithSignificantSpanWork, observeLongAnimationFrames, summarizeCpuProfile, summarizeLongTaskAttribution, summarizeLongTaskTrace, summarizeLongTaskWindow, summarizePerformancePhases, summarizeRpcTrace, type PerformanceCpuProfile, type PerformanceCpuSummary, type PerformancePhaseSummary, type PerformanceRpcCall, type PerformanceSpan, type PerformanceTaskAttribution} from './performanceRpcTrace';
import {startMeasurementAtClick, waitForFirstVisibleBubble} from './performanceMeasurement';

type Fixture = {
  owner: number,
  partner: number,
  middle_date: number
};

type Scale = '1x' | '100x';
type Variant = 'base' | 'head';

type Metric = {
  ms: number,
  requests: number,
  domNodes: number,
  domNodeCounts: {
    bubbles: number,
    bubbleGroups: number,
    dateGroups: number,
    groupAvatars: number,
    deletePlaceholders: number
  },
  bundleBytes: number,
  longTasksOver50Ms: number,
  blockingTimeMs: number,
  maxLongTaskDurationMs: number,
  rpcCallCount: number,
  rpcWallMs: number | null,
  nonRpcElapsedMs: number | null,
  rpcTraceEnabled: boolean,
  rpcSpansRecorded: boolean,
  rpcCalls: PerformanceRpcCall[],
  workerPhases?: PerformancePhaseSummary[],
  mainPhases?: PerformancePhaseSummary[],
  peerChangePhases?: PerformancePhaseSummary[],
  cpu?: PerformanceCpuSummary,
  longTaskAttribution?: PerformanceTaskAttribution[],
  scrollSpanTracing?: {installed: string[], spanCount: number, loafObserved: boolean},
  droppedFramePercent?: number,
  droppedFrames?: number,
  frameIntervals?: number,
  longTaskTrace?: ReturnType<typeof summarizeLongTaskTrace>,
  preInteractionMs?: number
};

type VariantRun = {
  variant: Variant,
  origin: string,
  storageState: Awaited<ReturnType<BrowserContext['storageState']>>
};

type MeasurementBoundary = {
  ms: number,
  startedAtMs: number,
  domNodes: number,
  domNodeCounts: Metric['domNodeCounts'],
  preInteractionMs?: number
};

type ScrollBackTraceOptions = {
  captureCpuStacks?: boolean,
  traceRpc?: boolean,
  waitForHistory?: boolean
};

const scales: Scale[] = ['1x', '100x'];
const fixturePaths: Record<Scale, string | undefined> = {
  '1x': process.env.PERF_FIXTURE_FILE_1X,
  '100x': process.env.PERF_FIXTURE_FILE_100X
};
const fixtures: Record<Scale, Fixture | undefined> = Object.fromEntries(scales.map((scale) => [
  scale,
  fixturePaths[scale] ? JSON.parse(readFileSync(fixturePaths[scale]!, 'utf8')) as Fixture : undefined
])) as Record<Scale, Fixture | undefined>;
const username = process.env.PERF_USERNAME;
const password = process.env.PERF_PASSWORD;
const reportPath = process.env.PERF_REPORT_PATH;
const report = {
  measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
  fixtureVersion: process.env.PERF_FIXTURE_VERSION || '',
  serverCommit: process.env.PERF_SERVER_COMMIT || '',
  fixtureServerCommit: process.env.PERF_FIXTURE_SERVER_COMMIT || '',
  requireBase: process.env.PERF_REQUIRE_BASE === 'true',
  requireTimingRepeats: process.env.PERF_REQUIRE_BASE === 'true',
  diagnostics: {} as Record<string, Record<string, unknown>>,
  variants: {
    base: {'1x': {}, '100x': {}},
    head: {'1x': {}, '100x': {}}
  } as Record<Variant, Record<Scale, Record<string, Partial<Metric>[]>>>
};
const preparedVariants: Record<Scale, Partial<Record<Variant, VariantRun>>> = {'1x': {}, '100x': {}};
const bundleRequestTrackers = new WeakMap<Page, BundleRequestTracker>();

const scenarios = ['coldChatList', 'warmChatList', 'chatOpen', 'scrollBack2k', 'dateJump', 'contactsList', 'contactSearch', 'globalSearch', 'sendMessage'];

test.afterAll(() => {
  if(reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
});

async function installInstrumentation(page: Page, requestCounter: {value: number}, origin: string, injectColdStall = false, observeAnimationFrames = false) {
  const bundleRequests = createBundleRequestTracker(new URL(origin).origin);
  bundleRequestTrackers.set(page, bundleRequests);
  page.on('request', (request) => {
    if(request.resourceType() !== 'websocket') ++requestCounter.value;
    bundleRequests.requestStarted(request);
  });
  page.on('requestfinished', (request) => bundleRequests.requestFinished(request));
  page.on('requestfailed', (request) => bundleRequests.requestFailed(request));
  page.on('worker', (worker) => bundleRequests.workerReady(worker.url()));
  await page.exposeBinding('__teagramBundleWorkerReady', (_source, url: string) => bundleRequests.workerReady(url));
  // Only the diagnostic pass observes long animation frames; the gated windows stay as instrumented as on master.
  if(observeAnimationFrames) await page.addInitScript({content: `window.__teagramObserveLongAnimationFrames = ${observeLongAnimationFrames.toString()};`});
  return page.addInitScript(({injectColdStall, observeAnimationFrames}: {injectColdStall: boolean, observeAnimationFrames: boolean}) => {
    // Playwright does not emit a page worker event for SharedWorker; use its first port message as the ready signal.
    const SharedWorkerConstructor = (window as any).SharedWorker;
    if(SharedWorkerConstructor) {
      (window as any).SharedWorker = new Proxy(SharedWorkerConstructor, {
        construct(target, args, newTarget) {
          const worker = Reflect.construct(target, args, newTarget) as SharedWorker;
          const url = new URL(String(args[0]), location.href).href;
          worker.port.addEventListener('message', () => {
            void (window as any).__teagramBundleWorkerReady(url);
          }, {once: true});
          worker.port.start();
          return worker;
        }
      });
    }
    performance.setResourceTimingBufferSize(1_000);
    const perf: any = (window as any).__teagramPerf = {
      longTasks: [] as Array<{startTime: number, duration: number}>,
      longAnimationFrames: [] as Array<{startTime: number, duration: number, scripts: Array<Record<string, unknown>>}>,
      frameIntervals: [] as number[],
      frameActive: false,
      started: performance.now(),
      resourceUrlBaseline: [] as string[]
    };
    try {
      const observer = new PerformanceObserver((list) => {
        perf.longTasks.push(...list.getEntries().filter((entry) => entry.duration > 50).map((entry) => ({
          startTime: entry.startTime,
          duration: entry.duration
        })));
      });
      observer.observe({type: 'longtask', buffered: true});
    } catch{}
    if(observeAnimationFrames) perf.loafObserved = (window as any).__teagramObserveLongAnimationFrames(PerformanceObserver, (entries: any[]) => {
      perf.longAnimationFrames.push(...entries.map((entry: any) => ({
        startTime: entry.startTime,
        duration: entry.duration,
        scripts: (entry.scripts || []).map((script: any) => ({
          sourceURL: script.sourceURL,
          sourceFunctionName: script.sourceFunctionName,
          invoker: script.invoker,
          invokerType: script.invokerType,
          executionStart: script.executionStart,
          duration: script.duration,
          forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration
        }))
      })));
    });
    perf.injectLongTask = (durationMs: number) => {
      const started = performance.now();
      while(performance.now() - started < durationMs) {}
      perf.injectedLongTask = {started, duration: performance.now() - started};
      return perf.injectedLongTask;
    };
    if(injectColdStall) setTimeout(() => perf.injectLongTask(100), 0);
    perf.startFrames = () => {
      perf.frameActive = true;
      perf.lastFrame = performance.now();
      const sampleFrame = (time: number) => {
        if(!perf.frameActive) return;
        perf.frameIntervals.push(time - perf.lastFrame);
        perf.lastFrame = time;
        requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);
    };
    perf.stopFrames = () => perf.frameActive = false;
  }, {injectColdStall, observeAnimationFrames});
}

async function waitForBundleResources(page: Page) {
  const bundleRequests = bundleRequestTrackers.get(page);
  if(!bundleRequests) throw new Error('Bundle request tracking was not installed for this page');
  await bundleRequests.waitForIdle(500, 10_000);
}

async function begin(page: Page, requests: {value: number}, recordRpcSpans = true, traceEnabled = false) {
  requests.value = 0;
  await page.evaluate(async({recordSpans, traceEnabled}) => {
    if(traceEnabled) await (window as any).rootScope.managers.apiManager.resetPerformanceRpcTrace(recordSpans);
    const perf = (window as any).__teagramPerf;
    perf.longTasks = [];
    perf.frameIntervals = [];
    perf.resourceUrlBaseline = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((entry) => entry.name);
    performance.clearResourceTimings();
    if(traceEnabled) performance.clearMeasures();
    perf.started = performance.now();
  }, {recordSpans: recordRpcSpans, traceEnabled});
}

async function capture(page: Page, requests: {value: number}, boundary: MeasurementBoundary, scroll = false, includePhases = false): Promise<Metric> {
  const requestCount = requests.value;
  await page.waitForTimeout(150);
  await waitForBundleResources(page);
  const captured = await page.evaluate(async({boundary, scroll, includePhases}) => {
    const {ms} = boundary;
    const perf = (window as any).__teagramPerf;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const resourceCaptureEndedAt = performance.now();
    const intervals = scroll ? perf.frameIntervals : [];
    const droppedFrames = intervals.reduce((total: number, interval: number) => total + Math.max(0, Math.round(interval / (1000 / 60)) - 1), 0);
    const droppedFramePercent = intervals.length ? droppedFrames / (droppedFrames + intervals.length) * 100 : 0;
    const longTasks = perf.longTasks.filter((entry: {startTime: number}) => entry.startTime >= perf.started);
    const apiManager = (window as any).rootScope.managers.apiManager;
    const rpcTrace = includePhases ? await apiManager.getPerformanceRpcTrace() as {
      enabled: boolean,
      recording: boolean,
      callCount: number,
      invocations: Array<{method: string, startedAtEpochMs: number}>,
      calls: Array<{
        method: string,
        startedAtEpochMs: number,
        durationMs: number | null,
        outcome: 'pending' | 'success' | 'error'
      }>
    } : {enabled: false, recording: false, callCount: 0, invocations: [], calls: []};
    const rpcInvocations = rpcTrace.invocations.filter((invocation) => {
      return invocation.startedAtEpochMs - performance.timeOrigin <= ms;
    });
    const workerPhases = includePhases ? (await apiManager.getPerformancePhaseTrace() as Array<{name: string, startedAtEpochMs: number, durationMs: number | null, accountNumber?: number}>).map((phase) => ({
      ...phase,
      startMs: Math.max(0, phase.startedAtEpochMs - performance.timeOrigin)
    })) : undefined;
    const mainPhases = includePhases ? performance.getEntriesByType('measure').filter((phase) => phase.name.startsWith('main.')).map((phase) => ({
      name: phase.name,
      startMs: Math.max(0, phase.startTime),
      durationMs: phase.duration
    })) : undefined;
    const rpcCalls = rpcTrace.calls.map((call) => ({
      method: call.method,
      startedAtMs: Math.max(0, call.startedAtEpochMs - performance.timeOrigin),
      durationMs: call.durationMs,
      outcome: call.outcome
    })).filter((call) => call.startedAtMs <= ms);
    return {
      bundleResources: resources.map((entry) => ({
        name: entry.name,
        startTime: entry.startTime,
        decodedBodySize: entry.decodedBodySize
      })),
      origin: location.origin,
      resourceCaptureEndedAt,
      resourceUrlBaseline: perf.resourceUrlBaseline,
      longTasks,
      longAnimationFrames: scroll ? perf.longAnimationFrames : [],
      rpcTraceEnabled: rpcTrace.enabled,
      rpcSpansRecorded: rpcTrace.recording,
      rpcCallCount: rpcTrace.recording ? rpcInvocations.length : rpcTrace.callCount,
      rpcCalls,
      workerPhases,
      mainPhases,
      droppedFramePercent: scroll && intervals.length ? droppedFramePercent : undefined,
      droppedFrames: scroll && intervals.length ? droppedFrames : undefined,
      frameIntervals: scroll && intervals.length ? intervals.length : undefined
    };
  }, {boundary, scroll, includePhases});
  const {bundleResources, origin, resourceCaptureEndedAt, resourceUrlBaseline, longTasks, longAnimationFrames, ...metrics} = captured;
  if(includePhases) expect(metrics.rpcTraceEnabled, 'performance RPC trace flag was not enabled in the diagnostic client build').toBe(true);
  const longTaskSummary = summarizeLongTaskWindow(longTasks, boundary.startedAtMs, boundary.ms);
  const rpcSummary = summarizeRpcTrace(metrics.rpcCalls as PerformanceRpcCall[], boundary.ms);
  return {
    ...metrics,
    bundleBytes: sumBundleBytes(bundleResources, origin, boundary.startedAtMs, resourceCaptureEndedAt, resourceUrlBaseline),
    ...longTaskSummary,
    ...(scroll ? {longTaskTrace: summarizeLongTaskTrace(longTasks, longAnimationFrames, boundary.startedAtMs, boundary.ms)} : {}),
    ms: boundary.ms,
    requests: requestCount,
    domNodes: boundary.domNodes,
    domNodeCounts: boundary.domNodeCounts,
    preInteractionMs: boundary.preInteractionMs,
    rpcWallMs: metrics.rpcSpansRecorded ? rpcSummary.rpcWallMs : null,
    nonRpcElapsedMs: metrics.rpcSpansRecorded ? rpcSummary.nonRpcElapsedMs : null,
    workerPhases: includePhases ? summarizePerformancePhases(metrics.workerPhases || []) : undefined,
    mainPhases: includePhases ? summarizePerformancePhases(metrics.mainPhases || []) : undefined
  };
}

async function installPeerChangeTracing(page: Page) {
  return page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    const phases: Array<{name: string, startMs: number, durationMs: number}> = [];
    const wrappedTargets = new WeakMap<object, Set<string>>();
    const base = performance.now();
    const wrap = (target: any, method: string, name: string) => {
      if(!target || typeof target[method] !== 'function') return;
      let wrappedMethods = wrappedTargets.get(target);
      if(!wrappedMethods) {
        wrappedMethods = new Set();
        wrappedTargets.set(target, wrappedMethods);
      }
      if(wrappedMethods.has(method)) return;
      wrappedMethods.add(method);
      const original = target[method];
      target[method] = function(...args: any[]) {
        const started = performance.now();
        const finish = () => phases.push({
          name,
          startMs: started - base,
          durationMs: Number((performance.now() - started).toFixed(2))
        });
        let result: any;
        try {
          result = original.apply(this, args);
        } catch(error) {
          finish();
          throw error;
        }
        if(result && typeof result.then === 'function') {
          result.then(finish, finish);
        } else {
          finish();
        }
        return result;
      };
    };
    const chat = (window as any).appImManager?.chat;
    if(!chat) return [];
    const wrapPeerChangeParts = () => {
      wrap(chat.bubbles, 'setPeer', 'bubbles.setPeer');
      wrap(chat.bubbles, 'getHistory1', 'bubbles.getHistory1');
      wrap(chat.bubbles, 'performHistoryResult', 'bubbles.performHistoryResult');
      wrap(chat.bubbles, 'finishPeerChange', 'bubbles.finishPeerChange');
      wrap(chat.input, 'finishPeerChange', 'input.finishPeerChange');
      wrap(chat.topbar, 'finishPeerChange', 'topbar.finishPeerChange');
    };
    wrap(chat, 'setPeer', 'chat.setPeer');
    wrap(chat, 'onChangePeer', 'chat.onChangePeer');
    wrap(chat, 'finishPeerChange', 'chat.finishPeerChange');
    wrap(chat, 'init', 'chat.init');
    const originalInit = chat.init;
    chat.init = function(...args: any[]) {
      const result = originalInit.apply(this, args);
      wrapPeerChangeParts();
      return result;
    };
    wrapPeerChangeParts();
    perf.peerChangePhases = phases;
    return phases;
  });
}

async function injectedLongTask(page: Page) {
  return page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    const task = perf.injectedLongTask;
    return {
      duration: task?.duration,
      observed: task && perf.longTasks.some((entry: {startTime: number, duration: number}) => entry.startTime <= task.started && entry.startTime + entry.duration >= task.started && entry.duration > 50)
    };
  });
}

function evaluateWithControlSamples(key: string, baseSamples: Metric[], headSamples: Metric[]) {
  expect(baseSamples).toHaveLength(COLD_CHAT_LIST_REPEATS);
  expect(headSamples).toHaveLength(COLD_CHAT_LIST_REPEATS);
  const base = {
    ...report.variants.base,
    '100x': {
      ...report.variants.base['100x'],
      [key]: baseSamples
    }
  };
  const head = {
    ...report.variants.head,
    '100x': {
      ...report.variants.head['100x'],
      [key]: headSamples
    }
  };
  return evaluatePerformance({...report, variants: {...report.variants, base, head}});
}

async function snapshotMeasurementBoundary(page: Page): Promise<MeasurementBoundary> {
  return page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    return {
      ms: performance.now() - perf.started,
      startedAtMs: perf.started,
      domNodes: document.querySelectorAll('*').length,
      domNodeCounts: {
        bubbles: document.querySelectorAll('.bubbles .bubble[data-mid]').length,
        bubbleGroups: document.querySelectorAll('.bubbles .bubbles-group').length,
        dateGroups: document.querySelectorAll('.bubbles .bubbles-date-group').length,
        groupAvatars: document.querySelectorAll('.bubbles .bubbles-group-avatar-container').length,
        deletePlaceholders: document.querySelectorAll('.bubbles .bubble-delete-placeholder').length
      },
      preInteractionMs: perf.preInteractionMs
    };
  });
}

async function startCpuProfile(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', {interval: 1_000});
  const beforeStart = await page.evaluate(() => performance.now());
  await session.send('Profiler.start');
  const afterStart = await page.evaluate(() => performance.now());
  // The profile's deltas count from the moment it started; the midpoint keeps the page-clock anchor within a few ms.
  return Object.assign(session, {perfStartMs: (beforeStart + afterStart) / 2});
}

async function stopCpuProfile(session: Awaited<ReturnType<typeof startCpuProfile>>) {
  const {profile} = await session.send('Profiler.stop');
  await session.detach();
  return {profile: profile as PerformanceCpuProfile, perfStartMs: session.perfStartMs};
}

async function finishCpuProfile(session: Awaited<ReturnType<typeof startCpuProfile>>) {
  const {profile} = await stopCpuProfile(session);
  return summarizeCpuProfile(profile);
}

// Records the synchronous part of history processing, scroll save/restore and mounting so long tasks in
// every measured head repeat can be joined to the work that ran inside them.
const SCROLL_SPAN_NAMES = [
  'bubbles.processBatch',
  'bubbles.getHistory1',
  'bubbles.performHistoryResult',
  'bubbles.groupBubbles',
  'bubbles.prepareToSaveScroll',
  'bubbles.createScrollSaver',
  'scrollSaver.save',
  'scrollSaver.restoreAfterLayout',
  'scrollSaver.restore',
  'bubbles.restoreScroll',
  'bubbles.onRenderScrollSet',
  'bubbles.getViewportSlice',
  'bubbles.deleteViewportSlice',
  'bubbles.commitBubbleReplacements',
  'bubbleGroups.mountUnmountGroups'
];

async function installScrollSpanTracing(page: Page) {
  const installed = await page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    const spans: Array<{name: string, startMs: number, syncMs: number}> = [];
    const installedNames: string[] = [];
    const wrappedScrollSavers = new WeakSet<object>();
    const wrap = (target: any, method: string, name: string, onResult?: (result: any) => void) => {
      if(!target || typeof target[method] !== 'function') return;
      if(!installedNames.includes(name)) installedNames.push(name);
      const original = target[method];
      target[method] = function(...args: any[]) {
        const startMs = performance.now();
        let result: any;
        try {
          result = original.apply(this, args);
        } finally {
          spans.push({name, startMs, syncMs: performance.now() - startMs});
        }
        onResult?.(result);
        return result;
      };
    };
    const bubbles = (window as any).appImManager?.chat?.bubbles;
    if(!bubbles) return installedNames;
    const instrumentScrollSaver = (scrollSaver: any) => {
      if(!scrollSaver || typeof scrollSaver !== 'object' || wrappedScrollSavers.has(scrollSaver)) return;
      wrappedScrollSavers.add(scrollSaver);
      wrap(scrollSaver, 'save', 'scrollSaver.save');
      wrap(scrollSaver, 'restoreAfterLayout', 'scrollSaver.restoreAfterLayout');
      wrap(scrollSaver, 'restore', 'scrollSaver.restore');
    };
    wrap(bubbles.batchProcessor, 'process', 'bubbles.processBatch');
    wrap(bubbles, 'getHistory1', 'bubbles.getHistory1');
    wrap(bubbles, 'performHistoryResult', 'bubbles.performHistoryResult');
    wrap(bubbles, 'groupBubbles', 'bubbles.groupBubbles');
    wrap(bubbles, 'prepareToSaveScroll', 'bubbles.prepareToSaveScroll', (result) => {
      instrumentScrollSaver(result?.scrollSaver);
      wrap(result, 'restoreScroll', 'bubbles.restoreScroll');
    });
    wrap(bubbles, 'createScrollSaver', 'bubbles.createScrollSaver', instrumentScrollSaver);
    wrap(bubbles, 'onRenderScrollSet', 'bubbles.onRenderScrollSet');
    wrap(bubbles, 'getViewportSlice', 'bubbles.getViewportSlice');
    wrap(bubbles, 'deleteViewportSlice', 'bubbles.deleteViewportSlice');
    wrap(bubbles, 'commitBubbleReplacements', 'bubbles.commitBubbleReplacements');
    wrap(bubbles.bubbleGroups, 'mountUnmountGroups', 'bubbleGroups.mountUnmountGroups');
    perf.scrollSpans = spans;
    perf.scrollSpanInstalled = installedNames;
    return installedNames;
  });
  // An empty span list reads as "no history call ran", so core hooks must install before scrolling starts.
  expect(installed).toContain('bubbles.processBatch');
  expect(installed).toContain('bubbles.createScrollSaver');
}

async function signIn(page: Page, origin: string) {
  await page.goto(origin, {waitUntil: 'domcontentloaded'});
  const auth = page.locator('#auth-pages');
  await expect(auth.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await auth.getByRole('textbox', {name: 'Username'}).fill(username!);
  await auth.getByRole('button', {name: 'Next'}).click();
  const passwordInput = auth.locator('input[name="notsearch_password"]');
  await expect(passwordInput).toBeVisible({timeout: 30_000});
  await passwordInput.fill(password!);
  await auth.getByRole('button', {name: 'Next'}).click();
  await expect(page.locator('#page-chats #chatlist-container .chatlist-chat').first()).toBeVisible({timeout: 120_000});
}

async function waitForChatList(page: Page) {
  await expect(page.locator('#page-chats #chatlist-container .chatlist-chat').first()).toBeVisible({timeout: 120_000});
}

async function waitForHistorySettled(page: Page) {
  let previousDomNodes = -1;
  let stableSamples = 0;
  await expect.poll(async() => {
    const state = await page.evaluate(() => {
      const bubbles = (window as any).appImManager.chat.bubbles;
      return {
        pending: !!(bubbles?.getHistoryTopPromise || bubbles?.getHistoryBottomPromise),
        domNodes: document.querySelectorAll('*').length
      };
    });
    stableSamples = !state.pending && state.domNodes === previousDomNodes ? stableSamples + 1 : 0;
    previousDomNodes = state.domNodes;
    return stableSamples >= 2;
  }, {timeout: 60_000, intervals: [100]}).toBe(true);
}

async function reloadChatList(page: Page, requests: {value: number}) {
  await begin(page, requests);
  await page.reload({waitUntil: 'domcontentloaded'});
  await waitForChatList(page);
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function openPartnerChat(page: Page, requests: {value: number}, fixture: Fixture) {
  const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
  await expect(row).toBeVisible({timeout: 60_000});
  await begin(page, requests);
  await startMeasurementAtClick(row);
  await row.click();
  const boundary = await waitForFirstVisibleBubble(page);
  expect(Number.isFinite(boundary.preInteractionMs), 'chat-open timer did not start on the row click').toBe(true);
  return capture(page, requests, boundary);
}

async function scrollBackTwoThousand(page: Page, requests: {value: number}, required: boolean, options: ScrollBackTraceOptions = {}) {
  const {captureCpuStacks = false, traceRpc = false, waitForHistory = false} = options;
  const hasPendingHistory = () => page.evaluate(() => {
    const bubbles = (window as any).appImManager.chat.bubbles;
    return !!(bubbles.getHistoryTopPromise || bubbles.getHistoryBottomPromise);
  });

  // Only the diagnostic pass waits: the gated window must keep the chat-open history tail it always had.
  if(waitForHistory) await waitForHistorySettled(page);
  if(captureCpuStacks) await installScrollSpanTracing(page);
  if(traceRpc) await begin(page, requests, true, true);
  else await begin(page, requests);
  const cpuProfile = captureCpuStacks ? await startCpuProfile(page) : undefined;
  await page.evaluate(() => (window as any).__teagramPerf.startFrames());
  const initial = await page.evaluate(() => {
    const mids = [...document.querySelectorAll<HTMLElement>('.bubbles .bubble[data-mid]')].map((bubble) => Number(bubble.dataset.mid));
    return {min: Math.min(...mids), max: Math.max(...mids)};
  });
  const targetMid = Math.max(1, initial.max - 2_000);
  let previousMin = initial.min;
  let stagnant = 0;
  let currentMin = initial.min;
  const scrollable = page.locator('.bubbles-scrollable');
  const box = await scrollable.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  for(let attempt = 0; attempt < 120 && currentMin > targetMid; ++attempt) {
    const before = currentMin;
    const scrollTop = await scrollable.evaluate((element) => element.scrollTop);
    if(scrollTop < 2) await scrollable.evaluate((element) => element.scrollTop = 2);
    await page.mouse.wheel(0, -2_000);
    await page.waitForTimeout(120);
    currentMin = await page.evaluate(() => {
      const mids = [...document.querySelectorAll<HTMLElement>('.bubbles .bubble[data-mid]')].map((bubble) => Number(bubble.dataset.mid));
      return Math.min(...mids);
    });
    if(currentMin >= before && await hasPendingHistory()) {
      await expect.poll(hasPendingHistory, {timeout: 120_000}).toBe(false);
      currentMin = await page.evaluate(() => {
        const mids = [...document.querySelectorAll<HTMLElement>('.bubbles .bubble[data-mid]')].map((bubble) => Number(bubble.dataset.mid));
        return Math.min(...mids);
      });
    }
    stagnant = currentMin < previousMin ? 0 : stagnant + 1;
    previousMin = currentMin;
    if(stagnant >= 12) break;
  }
  await page.evaluate(() => (window as any).__teagramPerf.stopFrames());
  const scrollState = await page.evaluate(() => {
    const chat = (window as any).appImManager.chat;
    const bubbles = chat?.bubbles;
    return {
      loadedAll: bubbles?.scrollable.loadedAll,
      scrollTop: bubbles?.scrollable.scrollPosition,
      scrollHeight: bubbles?.scrollable.scrollSize,
      lastScrollDirection: bubbles?.scrollable.lastScrollDirection,
      historyTopPending: !!bubbles?.getHistoryTopPromise,
      peerId: chat?.peerId
    };
  });
  if(currentMin > targetMid) {
    if(!required) return undefined;
    throw new Error(`scroll reached message ${currentMin}, expected ${targetMid}: ${JSON.stringify(scrollState)}`);
  }
  const boundary = await snapshotMeasurementBoundary(page);
  const stoppedProfile = cpuProfile ? await stopCpuProfile(cpuProfile) : undefined;
  const metric = await capture(page, requests, boundary, true, traceRpc);
  if(!stoppedProfile) return metric;

  const {tasks, spans} = await page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    return {
      tasks: perf.longTasks as Array<{startTime: number, duration: number}>,
      spans: (perf.scrollSpans || []) as PerformanceSpan[]
    };
  });
  const tracing = await page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    return {
      installed: perf.scrollSpanInstalled || [],
      spanCount: (perf.scrollSpans || []).length,
      loafObserved: perf.loafObserved === true
    };
  });
  expect(tracing.spanCount, 'scroll-back recorded no traced calls').toBeGreaterThan(0);
  expect(tracing.loafObserved, 'long-animation-frame observer is not supported in the diagnostic browser').toBe(true);
  expect([...tracing.installed].sort(), 'scroll-back tracing did not install every wrapped call').toEqual([...SCROLL_SPAN_NAMES].sort());
  const windowEndMs = boundary.startedAtMs + boundary.ms;
  const windowTasks = tasks.filter(({startTime}) => startTime >= boundary.startedAtMs && startTime < windowEndMs);
  return {
    ...metric,
    scrollSpanTracing: tracing,
    cpu: summarizeCpuProfile(stoppedProfile.profile),
    longTaskAttribution: summarizeLongTaskAttribution(windowTasks, spans, stoppedProfile.profile, stoppedProfile.perfStartMs, boundary.startedAtMs)
  };
}

async function jumpToFixtureDate(page: Page, requests: {value: number}, fixture: Fixture, allowUnsupportedBase: boolean): Promise<Metric | undefined> {
  await begin(page, requests);
  const beforeMids = await page.locator('.bubbles .bubble[data-mid]').evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).dataset.mid)));
  const searchIcon = String.fromCharCode(parseInt(Icons.search, 16));
  await page.locator('#page-chats .chat-utils > .btn-icon').filter({hasText: searchIcon}).click();
  const calendarIcon = String.fromCharCode(parseInt(Icons.calendar, 16));
  const searchCalendar = page.locator('#page-chats .topbar-search-container .topbar-search-right-filter > .btn-icon').filter({hasText: calendarIcon});
  await expect(page.locator('#page-chats .topbar-search-container')).toBeVisible();
  if(!await searchCalendar.count()) {
    if(allowUnsupportedBase) return undefined;
    throw new Error('date-jump calendar control is missing from the head build');
  }
  await expect(searchCalendar).toBeVisible();
  await searchCalendar.click();
  await expect(page.locator('.date-picker-scrollable')).toBeVisible();

  const targetDate = new Date(fixture.middle_date * 1000);
  targetDate.setHours(0, 0, 0, 0);
  const now = new Date();
  const monthDelta = (targetDate.getFullYear() - now.getFullYear()) * 12 + targetDate.getMonth() - now.getMonth();
  const nav = page.locator(monthDelta < 0 ? '.date-picker-prev' : '.date-picker-next');
  const title = page.locator('.date-picker-month-title');
  for(let step = 0; step < Math.abs(monthDelta); ++step) {
    const previousMonth = (await title.textContent())?.trim();
    await nav.click();
    await expect(title).not.toHaveText(previousMonth || '', {timeout: 5_000});
  }

  const expectedMonth = new Intl.DateTimeFormat('en-US', {month: 'long', year: 'numeric'}).format(targetDate);
  await page.waitForFunction((month) => {
    const normalize = (value: string | null) => value?.replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('.date-picker-month-section .date-picker-month-label')].some((label) => normalize(label.textContent) === month);
  }, expectedMonth, {timeout: 15_000});
  const selected = await page.evaluate(({month, day}) => {
    const normalize = (value: string | null) => value?.replace(/\s+/g, ' ').trim();
    const section = [...document.querySelectorAll<HTMLElement>('.date-picker-month-section')].find((item) => {
      return normalize(item.querySelector('.date-picker-month-label')?.textContent || null) === month;
    });
    const button = [...(section?.querySelectorAll<HTMLButtonElement>('.date-picker-month-date') || [])].find((item) => item.textContent?.trim() === String(day));
    if(!button || button.disabled) return false;
    button.click();
    return true;
  }, {month: expectedMonth, day: targetDate.getDate()});
  expect(selected).toBe(true);
  await page.getByRole('button', {name: 'Jump to Date'}).click();
  await page.waitForFunction((oldMids) => {
    const old = new Set(oldMids);
    return [...document.querySelectorAll<HTMLElement>('.bubbles .bubble[data-mid]')].some((bubble) => !old.has(Number(bubble.dataset.mid)));
  }, beforeMids, {timeout: 60_000});
  await waitForHistorySettled(page);
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function openContacts(page: Page, requests: {value: number}) {
  // appDialogsManager preloads the shared Lottie worker 200 ms after startup.
  // The reload before this scenario can render the chat list before that timer
  // fires, which would charge the startup worker request to opening Contacts.
  await page.waitForTimeout(250);
  await expect.poll(async() => page.evaluate(() => {
    const worker = performance.getEntriesByType('resource').find((entry) => entry.name.includes('tlottie.worker')) as PerformanceResourceTiming | undefined;
    return !!worker && worker.responseEnd > 0;
  }), {timeout: 10_000}).toBe(true);
  await waitForBundleResources(page);

  const workerRequests: string[] = [];
  const recordWorkerRequest = (request: Request) => {
    if(request.url().includes('tlottie.worker')) workerRequests.push(request.url());
  };
  page.on('request', recordWorkerRequest);
  try {
    await begin(page, requests);
    await page.locator('.sidebar-tools-button').click();
    await page.getByText('Contacts', {exact: true}).last().click();
    await expect(page.locator('#contacts-container .chatlist-chat').first()).toBeVisible({timeout: 60_000});
    const boundary = await snapshotMeasurementBoundary(page);
    const sample = await capture(page, requests, boundary);
    expect(workerRequests).toEqual([]);
    return sample;
  } finally {
    page.off('request', recordWorkerRequest);
  }
}

async function searchContacts(page: Page, requests: {value: number}, scale: Scale) {
  await begin(page, requests);
  const input = page.locator('#contacts-container .input-search-input');
  await input.fill(scale === '1x' ? 'k00099' : 'k09999');
  await expect(page.locator('#contacts-container .chatlist-chat').first()).toBeVisible({timeout: 60_000});
  await expect(page.locator('#contacts-container .chatlist-chat')).toHaveCount(1, {timeout: 60_000});
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function globalSearch(page: Page, requests: {value: number}, scale: Scale) {
  await page.locator('#contacts-container .sidebar-close-button').click();
  await begin(page, requests);
  await page.keyboard.press('Control+f');
  const input = page.locator('#column-left .item-main .sidebar-header .input-search-input');
  await expect(input).toBeVisible();
  await input.fill(`needle ${scale === '1x' ? '5000' : '500000'}`);
  await expect(page.locator('#search-container .chatlist-chat').first()).toBeVisible({timeout: 90_000});
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function sendMessage(page: Page, requests: {value: number}, fixture: Fixture) {
  await page.keyboard.press('Escape');
  await page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first().click();
  await expect(page.locator('#page-chats .bubbles .bubble[data-mid]').first()).toBeVisible();
  await begin(page, requests);
  const text = `web-perf-${process.env.GITHUB_RUN_ID || 'local'}-${Date.now()}`;
  const composer = page.locator('.input-message-input:not(.input-field-input-fake)[contenteditable="true"]');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.locator('#page-chats .bubbles .bubble.is-out').filter({hasText: text})).toBeVisible({timeout: 60_000});
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function prepareVariant(browser: Browser, variant: Variant, origin: string): Promise<VariantRun> {
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1280, height: 800}});
  try {
    const page = await context.newPage();
    await signIn(page, origin);
    return {variant, origin, storageState: await context.storageState({indexedDB: true})};
  } finally {
    await context.close();
  }
}

async function runColdChatList(browser: Browser, run: VariantRun): Promise<Metric> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });
  try {
    const page = await context.newPage();
    const requests = {value: 0};
    await installInstrumentation(page, requests, run.origin);
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    expect(await page.evaluate(() => Number.isFinite((window as any).__teagramPerf.started))).toBe(true);
    await waitForChatList(page);
    return await capture(page, requests, await snapshotMeasurementBoundary(page));
  } finally {
    await context.close();
  }
}

async function measureColdControlWindow(browser: Browser, run: VariantRun, injectStall: boolean) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });
  const page = await context.newPage();
  const requests = {value: 0};
  await installInstrumentation(page, requests, run.origin, injectStall);

  try {
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    expect(await page.evaluate(() => Number.isFinite((window as any).__teagramPerf.started))).toBe(true);
    await waitForChatList(page);
    const sample = await capture(page, requests, await snapshotMeasurementBoundary(page));
    return {sample, injectedTask: injectStall ? await injectedLongTask(page) : undefined};
  } finally {
    await context.close();
  }
}

// Both variants start from one signed-in snapshot so they share the auth key and cached client state.
function withOrigin(run: VariantRun, variant: Variant, origin: string): VariantRun {
  return {
    variant,
    origin,
    storageState: {
      ...run.storageState,
      origins: run.storageState.origins.map((entry) => entry.origin === run.origin ? {...entry, origin} : entry)
    }
  };
}

test.beforeAll(async({browser}) => {
  expect(username).toBeTruthy();
  expect(password).toBeTruthy();

  for(const scale of scales) {
    const fixture = fixtures[scale];
    expect(fixture, `${scale} fixture was not supplied`).toBeTruthy();
    expect(Number.isSafeInteger(fixture?.partner), `${scale} fixture partner is invalid`).toBe(true);
    expect(Number.isSafeInteger(fixture?.middle_date), `${scale} fixture date is invalid`).toBe(true);

    const suffix = scale.toUpperCase();
    const headOrigin = process.env[`PERF_HEAD_ORIGIN_${suffix}`];
    const baseOrigin = process.env[`PERF_BASE_ORIGIN_${suffix}`];
    expect(headOrigin, `${scale} head origin is missing`).toBeTruthy();
    if(report.requireBase) expect(baseOrigin, `${scale} base origin is missing`).toBeTruthy();

    const variants: Array<[Variant, string]> = report.requireBase ? [
      ['base', baseOrigin!],
      ['head', headOrigin!]
    ] : [['head', headOrigin!]];
    const [[firstVariant, firstOrigin]] = variants;
    const signedIn = await prepareVariant(browser, firstVariant, firstOrigin);
    for(const [variant, origin] of variants) {
      preparedVariants[scale][variant] = withOrigin(signedIn, variant, origin);
    }
  }
});

async function runVariant(browser: Browser, run: VariantRun, scale: Scale, fixture: Fixture) {
  const {variant, origin} = run;
  const measured = report.variants[variant][scale];
  for(const scenario of scenarios) measured[scenario] ||= [];

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });
  const page = await context.newPage();
  const requests = {value: 0};
  const captureScrollAttribution = variant === 'head' && scale === '100x';
  await installInstrumentation(page, requests, origin, false, captureScrollAttribution);

  try {
    await page.goto(origin, {waitUntil: 'domcontentloaded'});
    expect(await page.evaluate(() => Number.isFinite((window as any).__teagramPerf.started))).toBe(true);
    await waitForChatList(page);
    measured.coldChatList.push(await test.step('cold chat list', async() => capture(page, requests, await snapshotMeasurementBoundary(page))));
    measured.warmChatList.push(await test.step('warm chat list', () => reloadChatList(page, requests)));

    const chatOpen = await test.step('open scale fixture chat', () => openPartnerChat(page, requests, fixture));
    measured.chatOpen.push(chatOpen);
    const scroll = await test.step('scroll back 2,000 messages', () => scrollBackTwoThousand(
      page,
      requests,
      variant === 'head',
      captureScrollAttribution ? {captureCpuStacks: true} : undefined
    ));
    if(scroll) {
      measured.scrollBack2k.push(scroll);
    } else {
      // The base build may not reach the older history window. Its open-chat bundle is still the route baseline.
      measured.scrollBack2k.push({bundleBytes: chatOpen.bundleBytes});
    }
    const jump = await test.step('jump to fixture date', () => jumpToFixtureDate(page, requests, fixture, variant === 'base'), {timeout: 120_000});
    if(jump) {
      measured.dateJump.push(jump);
    } else {
      // The base build may lack the calendar control. Its open-chat bundle is still the route baseline.
      measured.dateJump.push({bundleBytes: chatOpen.bundleBytes});
    }

    // Reset both variants to the same signed-in chat-list state before contacts measurements.
    await page.goto(origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    measured.contactsList.push(await test.step('open contacts', () => openContacts(page, requests)));
    measured.contactSearch.push(await test.step('search contacts', () => searchContacts(page, requests, scale)));
    measured.globalSearch.push(await test.step('global message search', () => globalSearch(page, requests, scale)));
    measured.sendMessage.push(await test.step('send a message', () => sendMessage(page, requests, fixture)));
  } finally {
    await context.close();
  }
}

async function runTimingRepeat(browser: Browser, run: VariantRun, fixture: Fixture) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });
  const page = await context.newPage();
  const requests = {value: 0};
  await installInstrumentation(page, requests, run.origin);

  try {
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    const chatOpen = await openPartnerChat(page, requests, fixture);
    const scrollBack2k = await scrollBackTwoThousand(page, requests, run.variant === 'head');
    const send = await sendMessage(page, requests, fixture);
    return {chatOpen, scrollBack2k: scrollBack2k || {bundleBytes: chatOpen.bundleBytes}, send};
  } finally {
    await context.close();
  }
}

async function traceTargetScenarios(browser: Browser, run: VariantRun, fixture: Fixture) {
  const coldChatList: Metric[] = [];
  const warmChatList: Metric[] = [];
  let chatOpen: Metric;
  let scrollBack2k: Metric;
  const scrollBack2kRepeats: Metric[] = [];

  for(let repeat = 0; repeat < COLD_CHAT_LIST_REPEATS; ++repeat) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: {width: 1280, height: 800},
      storageState: run.storageState
    });
    const page = await context.newPage();
    const requests = {value: 0};
    await installInstrumentation(page, requests, run.origin, false, true);

    try {
      const coldProfile = repeat === 0 ? await startCpuProfile(page) : undefined;
      await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
      await waitForChatList(page);
      const coldBoundary = await snapshotMeasurementBoundary(page);
      const coldCapture = await capture(page, requests, coldBoundary, false, true);
      coldChatList.push({...coldCapture, ...(coldProfile ? {cpu: await finishCpuProfile(coldProfile)} : {})});

      await begin(page, requests, true, true);
      await page.evaluate(() => (window as any).rootScope.managers.apiManager.resetPerformancePhaseTrace());
      const warmProfile = repeat === 0 ? await startCpuProfile(page) : undefined;
      await page.reload({waitUntil: 'domcontentloaded'});
      await waitForChatList(page);
      const warmBoundary = await snapshotMeasurementBoundary(page);
      const warmCapture = await capture(page, requests, warmBoundary, false, true);
      warmChatList.push({...warmCapture, ...(warmProfile ? {cpu: await finishCpuProfile(warmProfile)} : {})});

      if(repeat < PERFORMANCE_REPEATS) {
        const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
        await expect(row).toBeVisible({timeout: 60_000});
        await begin(page, requests, true, true);
        await page.evaluate(() => (window as any).rootScope.managers.apiManager.resetPerformancePhaseTrace());
        await installPeerChangeTracing(page);
        const chatProfile = await startCpuProfile(page);
        await startMeasurementAtClick(row);
        await row.click();
        const chatOpenBoundary = await waitForFirstVisibleBubble(page);
        const chatCpu = await finishCpuProfile(chatProfile);
        const chatOpenCapture = await capture(page, requests, chatOpenBoundary, false, true);
        const peerChangePhases = await page.evaluate(() => (window as any).__teagramPerf.peerChangePhases || []);
        if(repeat === 0) {
          chatOpen = {
            ...chatOpenCapture,
            cpu: chatCpu,
            peerChangePhases: summarizePerformancePhases(peerChangePhases)
          };
        }
        // Every diagnostic repeat scrolls back, so each one's long tasks carry their own CPU stacks and spans.
        const scrolled = await test.step(`profile 100x scroll back 2,000 messages (repeat ${repeat + 1})`, () => scrollBackTwoThousand(page, requests, true, {
          captureCpuStacks: true,
          traceRpc: true,
          waitForHistory: true
        }));
        if(!scrolled || !('cpu' in scrolled)) throw new Error('scroll-back profile did not reach 2,000 messages');
        expect(scrolled.rpcSpansRecorded, 'scroll-back RPC spans were not recorded').toBe(true);
        expect(scrolled.cpu.sampledCpuMs, 'scroll-back CPU profile was empty').toBeGreaterThan(0);
        scrollBack2kRepeats.push(scrolled);
        if(repeat === 0) scrollBack2k = scrolled;
      }
    } finally {
      await context.close();
    }
  }

  return {coldChatList, warmChatList, chatOpen: chatOpen!, scrollBack2k: scrollBack2k!, scrollBack2kRepeats};
}

test('measures the scale fixture in interleaved base and head runs', async({browser}) => {
  expect(reportPath).toBeTruthy();

  for(const scale of scales) {
    const fixture = fixtures[scale];
    const variants: Variant[] = report.requireBase ? ['base', 'head'] : ['head'];

    for(let round = 0; round < PERFORMANCE_REPEATS; ++round) {
      const order = round % 2 === 0 ? variants : [...variants].reverse();
      for(const variant of order) {
        await test.step(`${scale} ${variant} round ${round + 1}`, () => runVariant(browser, preparedVariants[scale][variant]!, scale, fixture!));
      }
    }
  }

  if(report.requireTimingRepeats) {
    const timingVariants: Variant[] = report.requireBase ? ['base', 'head'] : ['head'];
    for(let repeat = PERFORMANCE_REPEATS; repeat < PERFORMANCE_TIMING_REPEATS; ++repeat) {
      const order = repeat % 2 === 0 ? timingVariants : [...timingVariants].reverse();
      for(const variant of order) {
        const run = preparedVariants['100x'][variant]!;
        const measured = await test.step(`100x ${variant} targeted timing repeat ${repeat + 1}`, () => runTimingRepeat(browser, run, fixtures['100x']!));
        report.variants[variant]['100x'].chatOpen.push(measured.chatOpen);
        report.variants[variant]['100x'].scrollBack2k.push(measured.scrollBack2k);
        report.variants[variant]['100x'].sendMessage.push(measured.send);
      }
    }
  }

  const coldScale: Scale = '100x';
  const coldVariants: Variant[] = report.requireBase ? ['base', 'head'] : ['head'];
  for(let repeat = PERFORMANCE_REPEATS; repeat < COLD_CHAT_LIST_REPEATS; ++repeat) {
    const order = repeat % 2 === 0 ? coldVariants : [...coldVariants].reverse();
    for(const variant of order) {
      const run = preparedVariants[coldScale][variant]!;
      const sample = await test.step(`${coldScale} ${variant} cold chat list round ${repeat + 1}`, () => runColdChatList(browser, run));
      report.variants[variant][coldScale].coldChatList.push(sample);
    }
  }
  const traceOrigin = process.env.PERF_TRACE_HEAD_ORIGIN_100X;
  expect(traceOrigin, '100x traced head origin is missing').toBeTruthy();
  const traceRun = withOrigin(preparedVariants['100x'].head!, 'head', traceOrigin!);
  report.diagnostics['100x'] = await test.step('trace 100x client CPU and RPC waits', () => traceTargetScenarios(browser, traceRun!, fixtures['100x']!));

  const headScrollRepeats = report.variants.head['100x'].scrollBack2k;
  expect(headScrollRepeats).toHaveLength(PERFORMANCE_REPEATS);
  headScrollRepeats.forEach((metric, repeat) => {
    expect(metric.longTaskAttribution, `100x head scroll repeat ${repeat + 1} is missing attributed long-task traces`).toBeDefined();
    expect(metric.longTaskTrace, `100x head scroll repeat ${repeat + 1} is missing long-task script traces`).toBeDefined();
    const historyPathTasks = findLongTasksWithSignificantSpanWork(metric.longTaskAttribution!, SCROLL_SPAN_NAMES);
    expect(
      historyPathTasks,
      `100x head scroll repeat ${repeat + 1} had a long task with over 50 ms or over half its duration in history scroll work: ${JSON.stringify({historyPathTasks, longTaskTrace: metric.longTaskTrace})}`
    ).toEqual([]);
  });
});

test('blocks repeated injected 100 ms main-thread stalls during cold chat list load', async({browser}) => {
  test.skip(!report.requireBase, 'negative control requires same-run base measurements');
  const preparedBase = preparedVariants['100x'].base;
  const preparedHead = preparedVariants['100x'].head;
  expect(preparedBase, '100x base sign-in snapshot was not prepared').toBeTruthy();
  expect(preparedHead, '100x head sign-in snapshot was not prepared').toBeTruthy();

  // Each repeat captures from document initialization so cold-start noise remains in the control window.
  const baseControlSamples: Metric[] = [];
  const negativeSamples: Metric[] = [];
  for(let repeat = 0; repeat < COLD_CHAT_LIST_REPEATS; ++repeat) {
    const order: Variant[] = repeat % 2 === 0 ? ['base', 'head'] : ['head', 'base'];
    for(const variant of order) {
      const isHead = variant === 'head';
      const run = isHead ? preparedHead! : preparedBase!;
      const {sample, injectedTask} = await measureColdControlWindow(browser, run, isHead);

      if(isHead) {
        expect(sample.longTasksOver50Ms).toBeGreaterThan(0);
        expect(injectedTask?.duration).toBeGreaterThanOrEqual(100);
        expect(injectedTask?.observed).toBe(true);
        expect(sample.maxLongTaskDurationMs).toBeGreaterThanOrEqual(100);
        negativeSamples.push(sample);
      } else {
        baseControlSamples.push(sample);
      }
    }
  }
  const coldLoadEvaluation = evaluateWithControlSamples('coldChatList', baseControlSamples, negativeSamples);
  const coldLoadFailures = coldLoadEvaluation.blockingFailures.filter((failure) => failure.startsWith('100x coldChatList: '));
  const blockingTimes = (samples: Metric[]) => samples.map((sample) => sample.blockingTimeMs);
  expect(coldLoadFailures.some((failure) => failure.includes('long task') || failure.includes('blocking time')), `100 ms control was not blocked: control blocking ${JSON.stringify(blockingTimes(negativeSamples))} ms vs same-phase base ${JSON.stringify(blockingTimes(baseControlSamples))} ms`).toBe(true);
});
