import {readFileSync, writeFileSync} from 'node:fs';
import {expect, test, type Browser, type BrowserContext, type Page} from '@playwright/test';
import Icons from '../src/icons';
import {COLD_CHAT_LIST_REPEATS, evaluatePerformance, PERFORMANCE_MEASUREMENT_VERSION, PERFORMANCE_REPEATS} from '../scripts/performance/policy.mjs';
import {createBundleRequestTracker, sumBundleBytes, type BundleRequestTracker} from './performanceBundleBytes';
import {CACHED_DIALOG_RECONCILE_PHASE_NAME, collectCachedDialogReconcileSummaries, getScenarioPreservedPerformancePhases, mergeCachedDialogReconcilePhaseSnapshots, observeLongAnimationFrames, reuseCachedPrivateWorkerUrl, summarizeCpuProfile, summarizeLongTaskAttribution, summarizeLongTaskTrace, summarizeLongTaskWindow, summarizePerformancePhases, summarizeRpcTrace, validateCachedDialogReconcileDiagnostics, validateCachedDialogReconcileSummaries, type CachedDialogReconcilePhase, type CachedDialogReconcileSummary, type PerformanceCpuProfile, type PerformanceCpuSummary, type PerformancePhaseSummary, type PerformanceRpcCall, type PerformanceSpan, type PerformanceTaskAttribution} from './performanceRpcTrace';

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
  cachedDialogReconcile?: CachedDialogReconcileSummary,
  cpu?: PerformanceCpuSummary,
  longTaskAttribution?: PerformanceTaskAttribution[],
  scrollSpanTracing?: {installed: string[], spanCount: number, loafObserved: boolean},
  droppedFramePercent?: number,
  droppedFrames?: number,
  frameIntervals?: number,
  longTaskTrace?: ReturnType<typeof summarizeLongTaskTrace>
};

type VariantRun = {
  variant: Variant,
  origin: string,
  storageState: Awaited<ReturnType<BrowserContext['storageState']>>
};

type MeasurementBoundary = {
  ms: number,
  startedAtMs: number,
  startedAtEpochMs: number,
  domNodes: number,
  domNodeCounts: Metric['domNodeCounts']
};

type CachedDialogReconcileTarget = {
  metric: Partial<Metric>,
  scenario: string,
  scenarioStartedAtEpochMs: number,
  scenarioEndedAtEpochMs: number,
  phaseSnapshots: CachedDialogReconcilePhase[]
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
  diagnostics: {} as Record<string, Record<string, unknown>>,
  variants: {
    base: {'1x': {}, '100x': {}},
    head: {'1x': {}, '100x': {}}
  } as Record<Variant, Record<Scale, Record<string, Partial<Metric>[]>>>
};
const preparedVariants: Record<Scale, Partial<Record<Variant, VariantRun>>> = {'1x': {}, '100x': {}};
const bundleRequestTrackers = new WeakMap<Page, BundleRequestTracker>();

const scenarios = ['coldChatList', 'warmChatList', 'chatOpen', 'scrollBack2k', 'dateJump', 'contactsList', 'contactSearch', 'globalSearch', 'sendMessage'];
const scenarioPreservedPerformancePhases = getScenarioPreservedPerformancePhases();

test.afterAll(() => {
  if(reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
});

async function installInstrumentation(page: Page, requestCounter: {value: number}, origin: string, injectColdStall = false, observeAnimationFrames = false, reusePrivateWorkerUrl = false) {
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
  // The diagnostic pass adds broad trace capture; gated windows use only the cached-dialog reconciliation timer.
  if(observeAnimationFrames) await page.addInitScript({content: `window.__teagramObserveLongAnimationFrames = ${observeLongAnimationFrames.toString()};`});
  const initScript = ({injectColdStall, observeAnimationFrames, reusePrivateWorkerUrl}: {injectColdStall: boolean, observeAnimationFrames: boolean, reusePrivateWorkerUrl: boolean}, reuseWorkerUrl: typeof reuseCachedPrivateWorkerUrl) => {
    // Playwright does not emit a page worker event for SharedWorker; use its first port message as the ready signal.
    const SharedWorkerConstructor = (window as any).SharedWorker;
    if(SharedWorkerConstructor) {
      (window as any).SharedWorker = new Proxy(SharedWorkerConstructor, {
        construct(target, args, newTarget) {
          const workerUrlKey = 'teagram-perf-private-worker-url';
          let currentWorkerUrl = String(args[0]);
          if(reusePrivateWorkerUrl && currentWorkerUrl.startsWith('blob:')) {
            try {
              const cachedWorkerUrl = sessionStorage.getItem(workerUrlKey);
              const stableWorkerUrl = reuseWorkerUrl(cachedWorkerUrl, currentWorkerUrl);
              if(stableWorkerUrl !== currentWorkerUrl) URL.revokeObjectURL(currentWorkerUrl);
              else sessionStorage.setItem(workerUrlKey, stableWorkerUrl);
              args = [stableWorkerUrl, ...args.slice(1)];
              currentWorkerUrl = stableWorkerUrl;
            } catch{}
          }
          const worker = Reflect.construct(target, args, newTarget) as SharedWorker;
          const url = new URL(currentWorkerUrl, location.href).href;
          (window as any).__teagramPerfSharedWorkerUrl = url;
          const perf = (window as any).__teagramPerf;
          if(perf) perf.sharedWorkerUrl = url;
          worker.port.addEventListener('message', () => {
            void (window as any).__teagramBundleWorkerReady(url);
          }, {once: true});
          worker.port.start();
          return worker;
        }
      });
    }
    performance.setResourceTimingBufferSize(1_000);
    // Cached dialog reconciliation can outlive the warm reload in this diagnostic context.
    const reconcileTimeStorageKey = 'teagram-perf-cached-dialog-reconcile-main-thread-ms';
    let cachedDialogsReconcileMainThreadMsByTraceId: Record<string, number> = {};
    if(location.origin !== 'null') {
      try {
        const storedTimes = JSON.parse(sessionStorage.getItem(reconcileTimeStorageKey) || '{}');
        if(storedTimes && typeof storedTimes === 'object' && !Array.isArray(storedTimes)) {
          cachedDialogsReconcileMainThreadMsByTraceId = Object.fromEntries(Object.entries(storedTimes).filter((entry): entry is [string, number] => {
            return typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0;
          }));
        }
      } catch{}
    }
    const perf: any = (window as any).__teagramPerf = {
      longTasks: [] as Array<{startTime: number, duration: number}>,
      longAnimationFrames: [] as Array<{startTime: number, duration: number, scripts: Array<Record<string, unknown>>}>,
      cachedDialogsReconcileMainThreadMsByTraceId,
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
  };
  return page.addInitScript({content: `(${initScript.toString()})(${JSON.stringify({injectColdStall, observeAnimationFrames, reusePrivateWorkerUrl})}, ${reuseCachedPrivateWorkerUrl.toString()});`});
}

async function keepPerformanceWorkerAlive(context: BrowserContext, page: Page, origin: string) {
  const workerUrl = await page.evaluate(() => (window as any).__teagramPerfSharedWorkerUrl as string | undefined);
  expect(workerUrl?.startsWith('blob:'), 'private shared worker URL was not captured').toBe(true);

  const anchor = await context.newPage();
  await anchor.route('**/*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body></body></html>'
  }));
  await anchor.goto(origin, {waitUntil: 'domcontentloaded'});
  await anchor.evaluate((url) => {
    const worker = new SharedWorker(url, {type: 'module'});
    worker.port.addEventListener('message', () => {});
    worker.port.start();
    (window as any).__teagramPerfWorkerKeepalive = worker;
  }, workerUrl!);
  await page.bringToFront();
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

async function beginScenario(page: Page, requests: {value: number}, traceEnabled = false) {
  if(!traceEnabled) {
    await begin(page, requests);
    return;
  }

  await begin(page, requests, true, true);
  await page.evaluate((preserveNames) => (window as any).rootScope.managers.apiManager.resetPerformancePhaseTrace(preserveNames), scenarioPreservedPerformancePhases);
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
    const workerPhases = includePhases ? (await apiManager.getPerformancePhaseTrace() as Array<{name: string, startedAtEpochMs: number, durationMs: number | null, accountNumber?: number, pageCount?: number}>).map((phase) => ({
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
      timeOrigin: performance.timeOrigin,
      resourceCaptureEndedAt,
      resourceUrlBaseline: perf.resourceUrlBaseline,
      longTasks,
      longAnimationFrames: includePhases ? perf.longAnimationFrames : [],
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
    ...(includePhases ? {longTaskTrace: summarizeLongTaskTrace(longTasks, longAnimationFrames, boundary.startedAtMs, boundary.ms)} : {}),
    ms: boundary.ms,
    requests: requestCount,
    domNodes: boundary.domNodes,
    domNodeCounts: boundary.domNodeCounts,
    rpcWallMs: metrics.rpcSpansRecorded ? rpcSummary.rpcWallMs : null,
    nonRpcElapsedMs: metrics.rpcSpansRecorded ? rpcSummary.nonRpcElapsedMs : null,
    workerPhases: includePhases ? summarizePerformancePhases(metrics.workerPhases || []) : undefined,
    mainPhases: includePhases ? summarizePerformancePhases(metrics.mainPhases || []) : undefined
  };
}

async function readCachedDialogReconcileSnapshot(page: Page) {
  const snapshot = await page.evaluate(async({phaseName, phaseStorageKey, timeStorageKey}) => {
    const apiManager = (window as any).rootScope.managers.apiManager;
    const workerPhases = (await apiManager.getPerformancePhaseTrace() as Array<{
      name: string,
      traceId?: string,
      startedAtEpochMs: number,
      durationMs: number | null,
      pageCount?: number
    }>).filter(({name, traceId}) => name === phaseName && typeof traceId === 'string') as CachedDialogReconcilePhase[];
    let storedPhases: CachedDialogReconcilePhase[] = [];
    try {
      const parsed = JSON.parse(sessionStorage.getItem(phaseStorageKey) || '{}');
      if(parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        storedPhases = Object.values(parsed).filter((phase: any) => (
          phase?.name === phaseName &&
          typeof phase.traceId === 'string' &&
          Number.isFinite(phase.startedAtEpochMs) &&
          (phase.durationMs === null || Number.isFinite(phase.durationMs))
        )) as CachedDialogReconcilePhase[];
      }
    } catch{}
    const perf = (window as any).__teagramPerf;
    const mainThreadTimeByTraceId: Record<string, number> = {};
    try {
      const storedTimes = JSON.parse(sessionStorage.getItem(timeStorageKey) || '{}');
      if(storedTimes && typeof storedTimes === 'object' && !Array.isArray(storedTimes)) {
        Object.entries(storedTimes).forEach(([traceId, duration]) => {
          if(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
            mainThreadTimeByTraceId[traceId] = duration;
          }
        });
      }
    } catch{}
    Object.entries(perf.cachedDialogsReconcileMainThreadMsByTraceId as Record<string, number>).forEach(([traceId, duration]) => {
      if(Number.isFinite(duration) && duration >= 0) {
        mainThreadTimeByTraceId[traceId] = Math.max(mainThreadTimeByTraceId[traceId] || 0, duration);
      }
    });
    return {workerPhases, storedPhases, mainThreadTimeByTraceId};
  }, {
    phaseName: CACHED_DIALOG_RECONCILE_PHASE_NAME,
    phaseStorageKey: 'teagram-perf-cached-dialog-reconcile-phases',
    timeStorageKey: 'teagram-perf-cached-dialog-reconcile-main-thread-ms'
  });
  return {
    phases: mergeCachedDialogReconcilePhaseSnapshots([snapshot.storedPhases, snapshot.workerPhases]),
    mainThreadTimeByTraceId: snapshot.mainThreadTimeByTraceId
  };
}

async function finalizeCachedDialogReconcileSummaries(page: Page, targets: CachedDialogReconcileTarget[]) {
  if(!targets.length) return;

  const readSnapshot = () => readCachedDialogReconcileSnapshot(page);

  let currentSnapshot = await readSnapshot();
  const mergePhases = () => {
    return mergeCachedDialogReconcilePhaseSnapshots([
      ...targets.map(({phaseSnapshots}) => phaseSnapshots),
      currentSnapshot.phases
    ]);
  };
  const latestScenarioEndAtEpochMs = Math.max(...targets.map(({scenarioEndedAtEpochMs}) => scenarioEndedAtEpochMs));
  await expect.poll(async() => {
    currentSnapshot = await readSnapshot();
    return mergePhases().filter((phase) => (
      phase.durationMs === null && phase.startedAtEpochMs < latestScenarioEndAtEpochMs
    )).map(({traceId}) => traceId);
  }, {
    message: 'a cached dialog reconciliation did not finish after the measured scenarios',
    timeout: 120_000,
    intervals: [100]
  }).toEqual([]);

  await expect.poll(async() => {
    currentSnapshot = await readSnapshot();
    const phases = mergePhases();
    const requiredTraceIds = targets.flatMap((target) => phases.filter((phase) => (
      phase.startedAtEpochMs < target.scenarioEndedAtEpochMs &&
      phase.durationMs !== null &&
      phase.startedAtEpochMs + phase.durationMs > target.scenarioStartedAtEpochMs
    )).map(({traceId}) => traceId));
    return requiredTraceIds.filter((traceId) => !Object.prototype.hasOwnProperty.call(currentSnapshot.mainThreadTimeByTraceId, traceId));
  }, {
    message: 'a cached dialog reconciliation mirror was not measured on the main thread',
    timeout: 120_000,
    intervals: [100]
  }).toEqual([]);

  const phases = mergePhases();
  const summaries = collectCachedDialogReconcileSummaries(targets, phases, currentSnapshot.mainThreadTimeByTraceId);
  targets.forEach((target, index) => target.metric.cachedDialogReconcile = summaries[index]);
}

async function addCachedDialogReconcileTarget(page: Page, targets: CachedDialogReconcileTarget[] | undefined, metric: Partial<Metric>, scenario: string) {
  if(!targets) return;
  expect(Number.isFinite(metric.ms), `${scenario} measurement duration is missing`).toBe(true);

  const scenarioStartedAtEpochMs = await page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    return performance.timeOrigin + perf.started;
  });
  const scenarioEndedAtEpochMs = scenarioStartedAtEpochMs + metric.ms!;
  const phaseSnapshots = (await readCachedDialogReconcileSnapshot(page)).phases;
  targets.push({
    metric,
    scenario,
    scenarioStartedAtEpochMs,
    scenarioEndedAtEpochMs,
    phaseSnapshots
  });
}

async function installPeerChangeTracing(page: Page) {
  return page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    const phases: Array<{name: string, startMs: number, durationMs: number}> = [];
    const base = performance.now();
    const wrap = (target: any, method: string, name: string) => {
      if(!target || typeof target[method] !== 'function') return;
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
    wrap(chat, 'setPeer', 'chat.setPeer');
    wrap(chat, 'onChangePeer', 'chat.onChangePeer');
    wrap(chat, 'finishPeerChange', 'chat.finishPeerChange');
    wrap(chat.bubbles, 'setPeer', 'bubbles.setPeer');
    wrap(chat.bubbles, 'getHistory1', 'bubbles.getHistory1');
    wrap(chat.bubbles, 'performHistoryResult', 'bubbles.performHistoryResult');
    wrap(chat.bubbles, 'finishPeerChange', 'bubbles.finishPeerChange');
    wrap(chat.input, 'finishPeerChange', 'input.finishPeerChange');
    wrap(chat.topbar, 'finishPeerChange', 'topbar.finishPeerChange');
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
    const startedAtMs = perf.started;
    return {
      ms: performance.now() - startedAtMs,
      startedAtMs,
      startedAtEpochMs: performance.timeOrigin + startedAtMs,
      domNodes: document.querySelectorAll('*').length,
      domNodeCounts: {
        bubbles: document.querySelectorAll('.bubbles .bubble[data-mid]').length,
        bubbleGroups: document.querySelectorAll('.bubbles .bubbles-group').length,
        dateGroups: document.querySelectorAll('.bubbles .bubbles-date-group').length,
        groupAvatars: document.querySelectorAll('.bubbles .bubbles-group-avatar-container').length,
        deletePlaceholders: document.querySelectorAll('.bubbles .bubble-delete-placeholder').length
      }
    };
  });
}

async function captureScenario(
  page: Page,
  requests: {value: number},
  traceEnabled = false,
  onMeasurementBoundary?: (boundary: MeasurementBoundary) => void
) {
  const boundary = await snapshotMeasurementBoundary(page);
  onMeasurementBoundary?.(boundary);
  return capture(page, requests, boundary, false, traceEnabled);
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

// Records the synchronous part of the history, grouping, slicing and mount calls so each long task in the
// scroll-back window can be joined to the work that began inside it. Only the diagnostic pass installs it.
const SCROLL_SPAN_NAMES = [
  'bubbles.getHistory1',
  'bubbles.performHistoryResult',
  'bubbles.groupBubbles',
  'bubbles.prepareToSaveScroll',
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
    const wrap = (target: any, method: string, name: string) => {
      if(!target || typeof target[method] !== 'function') return;
      installedNames.push(name);
      const original = target[method];
      target[method] = function(...args: any[]) {
        const startMs = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          spans.push({name, startMs, syncMs: performance.now() - startMs});
        }
      };
    };
    const bubbles = (window as any).appImManager?.chat?.bubbles;
    if(!bubbles) return installedNames;
    wrap(bubbles, 'getHistory1', 'bubbles.getHistory1');
    wrap(bubbles, 'performHistoryResult', 'bubbles.performHistoryResult');
    wrap(bubbles, 'groupBubbles', 'bubbles.groupBubbles');
    wrap(bubbles, 'prepareToSaveScroll', 'bubbles.prepareToSaveScroll');
    wrap(bubbles, 'getViewportSlice', 'bubbles.getViewportSlice');
    wrap(bubbles, 'deleteViewportSlice', 'bubbles.deleteViewportSlice');
    wrap(bubbles, 'commitBubbleReplacements', 'bubbles.commitBubbleReplacements');
    wrap(bubbles.bubbleGroups, 'mountUnmountGroups', 'bubbleGroups.mountUnmountGroups');
    perf.scrollSpans = spans;
    return installedNames;
  });
  // An empty span list reads as "no history call ran", so a span that failed to install must fail the run.
  expect(installed, 'scroll span tracing did not install every wrapped call').toEqual(SCROLL_SPAN_NAMES);
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
  await row.click();
  await expect(page.locator('#page-chats .bubbles .bubble[data-mid]').first()).toBeVisible({timeout: 60_000});
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function scrollBackTwoThousand(
  page: Page,
  requests: {value: number},
  required: boolean,
  profileTrace = false,
  onMeasurementBoundary?: (boundary: MeasurementBoundary) => void
) {
  const hasPendingHistory = () => page.evaluate(() => {
    const bubbles = (window as any).appImManager.chat.bubbles;
    return !!(bubbles.getHistoryTopPromise || bubbles.getHistoryBottomPromise);
  });

  // Only the diagnostic pass waits: the gated window must keep the chat-open history tail it always had.
  if(profileTrace) await waitForHistorySettled(page);
  await beginScenario(page, requests, profileTrace);
  if(profileTrace) await installScrollSpanTracing(page);
  const cpuProfile = profileTrace ? await startCpuProfile(page) : undefined;
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
  onMeasurementBoundary?.(boundary);
  const stoppedProfile = cpuProfile ? await stopCpuProfile(cpuProfile) : undefined;
  const metric = await capture(page, requests, boundary, true, profileTrace);
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
    return {spanCount: (perf.scrollSpans || []).length, loafObserved: perf.loafObserved === true};
  });
  expect(tracing.spanCount, 'scroll-back recorded no traced calls').toBeGreaterThan(0);
  expect(tracing.loafObserved, 'long-animation-frame observer is not supported in the diagnostic browser').toBe(true);
  return {
    ...metric,
    scrollSpanTracing: {installed: SCROLL_SPAN_NAMES, ...tracing},
    cpu: summarizeCpuProfile(stoppedProfile.profile),
    longTaskAttribution: summarizeLongTaskAttribution(tasks, spans, stoppedProfile.profile, stoppedProfile.perfStartMs, boundary.startedAtMs, boundary.ms)
  };
}

async function jumpToFixtureDate(
  page: Page,
  requests: {value: number},
  fixture: Fixture,
  allowUnsupportedBase: boolean,
  traceEnabled = false,
  onMeasurementBoundary?: (boundary: MeasurementBoundary) => void
): Promise<Metric | undefined> {
  await beginScenario(page, requests, traceEnabled);
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
  return captureScenario(page, requests, traceEnabled, onMeasurementBoundary);
}

async function openContacts(page: Page, requests: {value: number}, traceEnabled = false, onMeasurementBoundary?: (boundary: MeasurementBoundary) => void) {
  await waitForBundleResources(page);
  await beginScenario(page, requests, traceEnabled);
  await page.locator('.sidebar-tools-button').click();
  await page.getByText('Contacts', {exact: true}).last().click();
  await expect(page.locator('#contacts-container .chatlist-chat').first()).toBeVisible({timeout: 60_000});
  return captureScenario(page, requests, traceEnabled, onMeasurementBoundary);
}

async function searchContacts(page: Page, requests: {value: number}, scale: Scale, traceEnabled = false, onMeasurementBoundary?: (boundary: MeasurementBoundary) => void) {
  await beginScenario(page, requests, traceEnabled);
  const input = page.locator('#contacts-container .input-search-input');
  await input.fill(scale === '1x' ? 'k00099' : 'k09999');
  await expect(page.locator('#contacts-container .chatlist-chat').first()).toBeVisible({timeout: 60_000});
  await expect(page.locator('#contacts-container .chatlist-chat')).toHaveCount(1, {timeout: 60_000});
  return captureScenario(page, requests, traceEnabled, onMeasurementBoundary);
}

async function globalSearch(page: Page, requests: {value: number}, scale: Scale, traceEnabled = false, onMeasurementBoundary?: (boundary: MeasurementBoundary) => void) {
  await page.locator('#contacts-container .sidebar-close-button').click();
  await beginScenario(page, requests, traceEnabled);
  await page.keyboard.press('Control+f');
  const input = page.locator('#column-left .item-main .sidebar-header .input-search-input');
  await expect(input).toBeVisible();
  await input.fill(`needle ${scale === '1x' ? '5000' : '500000'}`);
  await expect(page.locator('#search-container .chatlist-chat').first()).toBeVisible({timeout: 90_000});
  return captureScenario(page, requests, traceEnabled, onMeasurementBoundary);
}

async function sendMessage(page: Page, requests: {value: number}, fixture: Fixture, traceEnabled = false, onMeasurementBoundary?: (boundary: MeasurementBoundary) => void) {
  await page.keyboard.press('Escape');
  await page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first().click();
  await expect(page.locator('#page-chats .bubbles .bubble[data-mid]').first()).toBeVisible();
  await beginScenario(page, requests, traceEnabled);
  const text = `web-perf-${process.env.GITHUB_RUN_ID || 'local'}-${Date.now()}`;
  const composer = page.locator('.input-message-input:not(.input-field-input-fake)[contenteditable="true"]');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.locator('#page-chats .bubbles .bubble.is-out').filter({hasText: text})).toBeVisible({timeout: 60_000});
  return captureScenario(page, requests, traceEnabled, onMeasurementBoundary);
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
    const boundary = await snapshotMeasurementBoundary(page);
    const sample = await capture(page, requests, boundary);
    if(run.variant === 'head') {
      const reconcileTargets: CachedDialogReconcileTarget[] = [];
      await addCachedDialogReconcileTarget(page, reconcileTargets, sample, 'coldChatList');
      await finalizeCachedDialogReconcileSummaries(page, reconcileTargets);
    }
    return sample;
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
  const reconcileTargets = variant === 'head' && scale === '100x' ? [] as CachedDialogReconcileTarget[] : undefined;
  await installInstrumentation(page, requests, origin, false, false, Boolean(reconcileTargets));

  try {
    await page.goto(origin, {waitUntil: 'domcontentloaded'});
    expect(await page.evaluate(() => Number.isFinite((window as any).__teagramPerf.started))).toBe(true);
    await waitForChatList(page);
    const coldChatList = await test.step('cold chat list', async() => capture(page, requests, await snapshotMeasurementBoundary(page)));
    measured.coldChatList.push(coldChatList);
    await addCachedDialogReconcileTarget(page, reconcileTargets, coldChatList, 'coldChatList');
    if(reconcileTargets) await keepPerformanceWorkerAlive(context, page, origin);
    const warmChatList = await test.step('warm chat list', () => reloadChatList(page, requests));
    measured.warmChatList.push(warmChatList);
    await addCachedDialogReconcileTarget(page, reconcileTargets, warmChatList, 'warmChatList');

    const chatOpen = await test.step('open scale fixture chat', () => openPartnerChat(page, requests, fixture));
    measured.chatOpen.push(chatOpen);
    await addCachedDialogReconcileTarget(page, reconcileTargets, chatOpen, 'chatOpen');
    const scroll = await test.step('scroll back 2,000 messages', () => scrollBackTwoThousand(page, requests, variant === 'head'));
    if(scroll) {
      measured.scrollBack2k.push(scroll);
      await addCachedDialogReconcileTarget(page, reconcileTargets, scroll, 'scrollBack2k');
    } else {
      // The base build may not reach the older history window. Its open-chat bundle is still the route baseline.
      measured.scrollBack2k.push({bundleBytes: chatOpen.bundleBytes});
    }
    const jump = await test.step('jump to fixture date', () => jumpToFixtureDate(page, requests, fixture, variant === 'base'), {timeout: 120_000});
    if(jump) {
      measured.dateJump.push(jump);
      await addCachedDialogReconcileTarget(page, reconcileTargets, jump, 'dateJump');
    } else {
      // The base build may lack the calendar control. Its open-chat bundle is still the route baseline.
      measured.dateJump.push({bundleBytes: chatOpen.bundleBytes});
    }

    // Reset both variants to the same signed-in chat-list state before contacts measurements.
    await page.goto(origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    const contactsList = await test.step('open contacts', () => openContacts(page, requests));
    measured.contactsList.push(contactsList);
    await addCachedDialogReconcileTarget(page, reconcileTargets, contactsList, 'contactsList');
    const contactSearch = await test.step('search contacts', () => searchContacts(page, requests, scale));
    measured.contactSearch.push(contactSearch);
    await addCachedDialogReconcileTarget(page, reconcileTargets, contactSearch, 'contactSearch');
    const globalSearchSample = await test.step('global message search', () => globalSearch(page, requests, scale));
    measured.globalSearch.push(globalSearchSample);
    await addCachedDialogReconcileTarget(page, reconcileTargets, globalSearchSample, 'globalSearch');
    const sendMessageSample = await test.step('send a message', () => sendMessage(page, requests, fixture));
    measured.sendMessage.push(sendMessageSample);
    await addCachedDialogReconcileTarget(page, reconcileTargets, sendMessageSample, 'sendMessage');
    if(reconcileTargets) await finalizeCachedDialogReconcileSummaries(page, reconcileTargets);
  } finally {
    await context.close();
  }
}

async function traceTargetScenarios(browser: Browser, run: VariantRun, fixture: Fixture) {
  const traceSamples = Object.fromEntries(scenarios.map((scenario) => [scenario, [] as Metric[]])) as Record<string, Metric[]>;

  for(let repeat = 0; repeat < COLD_CHAT_LIST_REPEATS; ++repeat) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: {width: 1280, height: 800},
      storageState: run.storageState
    });
    const page = await context.newPage();
    const requests = {value: 0};
    await installInstrumentation(page, requests, run.origin, false, true, true);

    try {
      const reconcileTargets: CachedDialogReconcileTarget[] = [];
      const coldProfile = repeat === 0 ? await startCpuProfile(page) : undefined;
      await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
      await waitForChatList(page);
      const coldBoundary = await snapshotMeasurementBoundary(page);
      const coldCapture = await capture(page, requests, coldBoundary, false, true);
      const coldSample = {...coldCapture, ...(coldProfile ? {cpu: await finishCpuProfile(coldProfile)} : {})};
      traceSamples.coldChatList.push(coldSample);
      await addCachedDialogReconcileTarget(page, reconcileTargets, coldSample, 'coldChatList');

      if(repeat < PERFORMANCE_REPEATS) {
        await keepPerformanceWorkerAlive(context, page, run.origin);
        await beginScenario(page, requests, true);
        const warmProfile = repeat === 0 ? await startCpuProfile(page) : undefined;
        await page.reload({waitUntil: 'domcontentloaded'});
        await waitForChatList(page);
        const warmBoundary = await snapshotMeasurementBoundary(page);
        const warmCapture = await capture(page, requests, warmBoundary, false, true);
        const warmSample = {...warmCapture, ...(warmProfile ? {cpu: await finishCpuProfile(warmProfile)} : {})};
        traceSamples.warmChatList.push(warmSample);
        await addCachedDialogReconcileTarget(page, reconcileTargets, warmSample, 'warmChatList');

        const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
        await expect(row).toBeVisible({timeout: 60_000});
        await beginScenario(page, requests, true);
        await installPeerChangeTracing(page);
        const chatProfile = await startCpuProfile(page);
        await row.click();
        await expect(page.locator('#page-chats .bubbles .bubble[data-mid]').first()).toBeVisible({timeout: 60_000});
        const chatOpenBoundary = await snapshotMeasurementBoundary(page);
        const chatCpu = await finishCpuProfile(chatProfile);
        const chatOpenCapture = await capture(page, requests, chatOpenBoundary, false, true);
        const chatOpenSample = {
          ...chatOpenCapture,
          cpu: chatCpu,
          peerChangePhases: summarizePerformancePhases(await page.evaluate(() => (window as any).__teagramPerf.peerChangePhases || []))
        };
        traceSamples.chatOpen.push(chatOpenSample);
        await addCachedDialogReconcileTarget(page, reconcileTargets, chatOpenSample, 'chatOpen');
        // Every diagnostic repeat scrolls back, so each one's long tasks carry their own CPU stacks and spans.
        let scrollBoundary: MeasurementBoundary | undefined;
        const scrolled = await test.step(`profile 100x scroll back 2,000 messages (repeat ${repeat + 1})`, () => scrollBackTwoThousand(
          page,
          requests,
          true,
          true,
          (boundary) => scrollBoundary = boundary
        ));
        if(!scrolled || !('cpu' in scrolled)) throw new Error('scroll-back profile did not reach 2,000 messages');
        expect(scrolled.rpcSpansRecorded, 'scroll-back RPC spans were not recorded').toBe(true);
        expect(scrolled.cpu.sampledCpuMs, 'scroll-back CPU profile was empty').toBeGreaterThan(0);
        if(!scrollBoundary) throw new Error('scroll-back measurement boundary was not recorded');
        traceSamples.scrollBack2k.push(scrolled);
        await addCachedDialogReconcileTarget(page, reconcileTargets, scrolled, 'scrollBack2k');

        let dateJumpBoundary: MeasurementBoundary | undefined;
        const jumped = await test.step(`profile 100x date jump (repeat ${repeat + 1})`, () => jumpToFixtureDate(
          page,
          requests,
          fixture,
          false,
          true,
          (boundary) => dateJumpBoundary = boundary
        ));
        if(!jumped || !dateJumpBoundary) throw new Error('date-jump profile did not record its measurement boundary');
        traceSamples.dateJump.push(jumped);
        await addCachedDialogReconcileTarget(page, reconcileTargets, jumped, 'dateJump');

        await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
        await waitForChatList(page);

        let contactsBoundary: MeasurementBoundary | undefined;
        const contacts = await test.step(`profile 100x contacts list (repeat ${repeat + 1})`, () => openContacts(
          page,
          requests,
          true,
          (boundary) => contactsBoundary = boundary
        ));
        if(!contactsBoundary) throw new Error('contacts profile did not record its measurement boundary');
        traceSamples.contactsList.push(contacts);
        await addCachedDialogReconcileTarget(page, reconcileTargets, contacts, 'contactsList');

        let contactSearchBoundary: MeasurementBoundary | undefined;
        const contactSearch = await test.step(`profile 100x contact search (repeat ${repeat + 1})`, () => searchContacts(
          page,
          requests,
          '100x',
          true,
          (boundary) => contactSearchBoundary = boundary
        ));
        if(!contactSearchBoundary) throw new Error('contact-search profile did not record its measurement boundary');
        traceSamples.contactSearch.push(contactSearch);
        await addCachedDialogReconcileTarget(page, reconcileTargets, contactSearch, 'contactSearch');

        let globalSearchBoundary: MeasurementBoundary | undefined;
        const globalSearchSample = await test.step(`profile 100x global search (repeat ${repeat + 1})`, () => globalSearch(
          page,
          requests,
          '100x',
          true,
          (boundary) => globalSearchBoundary = boundary
        ));
        if(!globalSearchBoundary) throw new Error('global-search profile did not record its measurement boundary');
        traceSamples.globalSearch.push(globalSearchSample);
        await addCachedDialogReconcileTarget(page, reconcileTargets, globalSearchSample, 'globalSearch');

        let sendMessageBoundary: MeasurementBoundary | undefined;
        const sent = await test.step(`profile 100x send message (repeat ${repeat + 1})`, () => sendMessage(
          page,
          requests,
          fixture,
          true,
          (boundary) => sendMessageBoundary = boundary
        ));
        if(!sendMessageBoundary) throw new Error('send-message profile did not record its measurement boundary');
        traceSamples.sendMessage.push(sent);
        await addCachedDialogReconcileTarget(page, reconcileTargets, sent, 'sendMessage');
      }

      // Finish the measured windows first, then wait for the diagnostic phase so each window gets its final page and time totals.
      await finalizeCachedDialogReconcileSummaries(page, reconcileTargets);
    } finally {
      await context.close();
    }
  }

  for(const scenario of scenarios) {
    const expectedRepeatCount = scenario === 'coldChatList' ? COLD_CHAT_LIST_REPEATS : PERFORMANCE_REPEATS;
    validateCachedDialogReconcileDiagnostics(traceSamples[scenario], scenario, expectedRepeatCount);
  }

  return traceSamples;
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
  for(const scenario of scenarios) {
    const expectedRepeatCount = scenario === 'coldChatList' ? COLD_CHAT_LIST_REPEATS : PERFORMANCE_REPEATS;
    validateCachedDialogReconcileSummaries(report.variants.head['100x'][scenario], scenario, expectedRepeatCount);
  }
  const traceOrigin = process.env.PERF_TRACE_HEAD_ORIGIN_100X;
  expect(traceOrigin, '100x traced head origin is missing').toBeTruthy();
  const traceRun = withOrigin(preparedVariants['100x'].head!, 'head', traceOrigin!);
  report.diagnostics['100x'] = await test.step('trace 100x client CPU and RPC waits', () => traceTargetScenarios(browser, traceRun!, fixtures['100x']!));
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
