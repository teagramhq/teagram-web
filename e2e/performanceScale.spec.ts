import {installWorkerMessageAttribution, summarizeWorkerMessageAttribution} from './workerMessageAttribution';
import {readFileSync} from 'node:fs';
import {writePerformanceReport} from './performanceReport';
import {expect, test, type Browser, type BrowserContext, type Locator, type Page, type Request} from '@playwright/test';
import Icons from '../src/icons';
import {COLD_CHAT_LIST_REPEATS, evaluatePerformance, PERFORMANCE_MEASUREMENT_VERSION, PERFORMANCE_REPEATS} from '../scripts/performance/policy.mjs';
import {createBundleRequestTracker, sumBundleBytes, type BundleRequestTracker} from './performanceBundleBytes';
import {CACHED_DIALOG_RECONCILE_PHASE_NAME, classifyMeasuredLongTaskTrace, collectCachedDialogReconcileSummaries, getScenarioPreservedPerformancePhases, mergeCachedDialogReconcilePhaseSnapshots, settleInterruptedCachedDialogReconciles, observeLongAnimationFrames, rpcInvocationsInWindow, rpcMethodCounts, selectHistoryPathTasks, summarizeCpuProfile, summarizeLongTaskAttribution, summarizeLongTaskTrace, summarizeLongTaskWindow, summarizePerformancePhases, summarizeReconcileMirrorTasks, summarizeRpcTrace, validateCachedDialogReconcileDiagnostics, validateNoWalkLongTasks, type CachedDialogReconcilePhase, type CachedDialogReconcileSummary, type PerformanceCpuProfile, type PerformanceCpuSummary, type PerformancePhaseSummary, type PerformanceRpcCall, type PerformanceSpan, type PerformanceTaskAttribution, type ReconcileMirrorTask} from './performanceRpcTrace';
import {beginMeasurement as begin, finishIncompleteScroll, getContactsFailureDetails, getContactsRpcFailureDetails, startMeasurementAtClick, waitForFirstVisibleBubble, type DomNodeCounts} from './performanceMeasurement';
import {startFrameTrace, stopFrameTrace, summarizeDroppedFrames, summarizeFrameScripts} from './performanceFrameTrace';

type Fixture = {
  owner: number,
  partner: number,
  middle_date: number
};

type Scale = '1x' | '100x';
type Variant = 'base' | 'head';
const PERFORMANCE_TIMING_REPEATS = 5;
const REPORT_ONLY_SEND_REPEATS = 11;

type Metric = {
  ms: number,
  requests: number,
  domNodes: number,
  domClassCounts: Record<string, number>,
  domNodeCounts: DomNodeCounts,
  bundleBytes: number,
  longTasksOver50Ms: number,
  blockingTimeMs: number,
  maxLongTaskDurationMs: number,
  rpcCallCount: number,
  rpcMethodCounts?: Record<string, number>,
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
  workerMessageAttribution?: ReturnType<typeof summarizeWorkerMessageAttribution>,
  historyPathTasks?: PerformanceTaskAttribution[],
  scrollSpanTracing?: {installed: string[], spanCount: number, loafObserved: boolean},
  droppedFramePercent?: number,
  droppedFrames?: number,
  frameIntervals?: number,
  droppedFrameAttribution?: ReturnType<typeof summarizeDroppedFrames>,
  droppedFrameCpu?: PerformanceTaskAttribution[],
  droppedFrameScripts?: ReturnType<typeof summarizeFrameScripts>,
  longTaskTrace?: ReturnType<typeof summarizeLongTaskTrace>,
  longTaskTraceStatus?: ReturnType<typeof classifyMeasuredLongTaskTrace>,
  reconcileMirrorTasks?: ReconcileMirrorTask[],
  preInteractionMs?: number,
  appSendUiMs?: number,
  composerReadyAfterFirstBubbleMs?: number,
  firstBubbleToSentMs?: number
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
  domClassCounts: Metric['domClassCounts'],
  domNodeCounts: Metric['domNodeCounts'],
  preInteractionMs?: number
};

type CachedDialogReconcileTarget = {
  metric: Partial<Metric>,
  scenario: string,
  scenarioStartedAtEpochMs: number,
  scenarioEndedAtEpochMs: number,
  pageStartedAtEpochMs: number,
  phaseSnapshots: CachedDialogReconcilePhase[]
};

type ScrollBackTraceOptions = {
  captureCpuStacks?: boolean,
  captureFrameTrace?: boolean,
  captureWorkerMessages?: boolean,
  traceRpc?: boolean,
  waitForHistory?: boolean,
  includeLongTaskTrace?: boolean,
  onMeasurementBoundary?: (boundary: MeasurementBoundary) => void
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
const recorderReplayPath = process.env.PERF_RECORDER_REPLAY_PATH;
let recorderReplay: unknown;
try {
  if(recorderReplayPath) recorderReplay = JSON.parse(readFileSync(recorderReplayPath, 'utf8'));
} catch {
  // The replay gate reports missing or failed measurements.
}
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
const scenarioPreservedPerformancePhases = getScenarioPreservedPerformancePhases();
let measurementsStarted = false;
let measurementsComplete = false;

test.afterAll(() => {
  if(!measurementsStarted) return;
  if(reportPath) writePerformanceReport(reportPath, report);
  if(!measurementsComplete) return;
  scenarios.forEach((scenario) => {
    const diagnosticSamples = report.diagnostics['100x']?.[scenario];
    if(Array.isArray(diagnosticSamples)) validateNoWalkLongTasks(diagnosticSamples, `100x ${scenario} diagnostic`);
  });
});

async function installInstrumentation(page: Page, requestCounter: {value: number}, origin: string, injectColdStall = false, observeAnimationFrames = false, recordWorkerMessages = observeAnimationFrames) {
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
  // The gated scroll repeat starts this observer only for the measured window.
  await page.addInitScript({content: `window.__teagramObserveLongAnimationFrames = ${observeLongAnimationFrames.toString()};`});
  if(recordWorkerMessages) await page.addInitScript({content: `window.__teagramInstallWorkerMessageAttribution = ${installWorkerMessageAttribution.toString()};`});
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
      cachedDialogsReconcileMirrorTasks: [] as Array<{traceId: string, startedAtMs: number, durationMs: number}>,
      frameIntervals: [] as number[],
      frameWindows: [] as Array<{startMs: number, endMs: number}>,
      frameActive: false,
      started: performance.now(),
      resourceUrlBaseline: [] as string[]
    };
    let longAnimationFrameObserver: PerformanceObserver | undefined;
    try {
      const observer = new PerformanceObserver((list) => {
        perf.longTasks.push(...list.getEntries().filter((entry) => entry.duration > 50).map((entry) => ({
          startTime: entry.startTime,
          duration: entry.duration
        })));
      });
      observer.observe({type: 'longtask', buffered: true});
    } catch{}
    perf.startLongAnimationFrames = () => {
      if(longAnimationFrameObserver) return true;
      perf.loafObserved = (window as any).__teagramObserveLongAnimationFrames(PerformanceObserver, (entries: any[]) => {
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
      }, (observer: PerformanceObserver) => longAnimationFrameObserver = observer);
      return perf.loafObserved;
    };
    perf.stopLongAnimationFrames = () => {
      longAnimationFrameObserver?.disconnect();
      longAnimationFrameObserver = undefined;
    };
    if(observeAnimationFrames) perf.startLongAnimationFrames();
    perf.injectLongTask = (durationMs: number) => {
      const started = performance.now();
      while(performance.now() - started < durationMs) {}
      perf.injectedLongTask = {started, duration: performance.now() - started};
      return perf.injectedLongTask;
    };
    if(injectColdStall) setTimeout(() => perf.injectLongTask(100), 0);
    perf.startFrames = (recordWindows: boolean) => {
      perf.frameActive = true;
      perf.lastFrame = performance.now();
      const sampleFrame = (time: number) => {
        if(!perf.frameActive) return;
        perf.frameIntervals.push(time - perf.lastFrame);
        if(recordWindows) perf.frameWindows.push({startMs: perf.lastFrame, endMs: time});
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

async function beginScenario(page: Page, requests: {value: number}, traceEnabled = false, captureWorkerMessages = false) {
  await begin(page, requests, true, traceEnabled, captureWorkerMessages);
  if(!traceEnabled) return;
  await page.evaluate((preserveNames) => (window as any).rootScope.managers.apiManager.resetPerformancePhaseTrace(preserveNames), scenarioPreservedPerformancePhases);
  await page.evaluate(() => (window as any).__teagramPerf.startLongAnimationFrames());
}

async function capture(page: Page, requests: {value: number}, boundary: MeasurementBoundary, scroll = false, includePhases = false, includeLongTaskTrace = includePhases): Promise<Metric> {
  const requestCount = requests.value;
  await page.waitForTimeout(150);
  await waitForBundleResources(page);
  const captured = await page.evaluate(async({scroll, includePhases, includeLongTaskTrace}) => {
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
    const workerPhases = includePhases ? (await apiManager.getPerformancePhaseTrace() as Array<{name: string, startedAtEpochMs: number, durationMs: number | null, accountNumber?: number, pageCount?: number}>).map((phase) => ({
      ...phase,
      startMs: Math.max(0, phase.startedAtEpochMs - performance.timeOrigin)
    })) : undefined;
    const mainPhases = includePhases ? performance.getEntriesByType('measure').filter((phase) => phase.name.startsWith('main.')).map((phase) => ({
      name: phase.name,
      startMs: Math.max(0, phase.startTime),
      durationMs: phase.duration
    })) : undefined;
    const longAnimationFrames = includeLongTaskTrace ? perf.longAnimationFrames.slice() : [];
    const loafObserved = perf.loafObserved as boolean | undefined;
    if(includeLongTaskTrace) perf.stopLongAnimationFrames();
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
      longAnimationFrames,
      frameWindows: scroll && includeLongTaskTrace ? perf.frameWindows.slice() as Array<{startMs: number, endMs: number}> : [],
      reconcileMirrorTasks: includePhases ? perf.cachedDialogsReconcileMirrorTasks.slice() : [],
      loafObserved,
      rpcTraceEnabled: rpcTrace.enabled,
      rpcSpansRecorded: rpcTrace.recording,
      rpcCallCount: rpcTrace.callCount,
      rpcInvocations: rpcTrace.invocations,
      rpcRawCalls: rpcTrace.calls,
      workerPhases,
      mainPhases,
      droppedFramePercent: scroll && intervals.length ? droppedFramePercent : undefined,
      droppedFrames: scroll && intervals.length ? droppedFrames : undefined,
      frameIntervals: scroll && intervals.length ? intervals.length : undefined
    };
  }, {scroll, includePhases, includeLongTaskTrace});
  const {bundleResources, origin, resourceCaptureEndedAt, resourceUrlBaseline, longTasks, longAnimationFrames, frameWindows, reconcileMirrorTasks, loafObserved, rpcInvocations, rpcRawCalls, timeOrigin, ...metrics} = captured;
  if(includePhases) expect(metrics.rpcTraceEnabled, 'performance RPC trace flag was not enabled in the diagnostic client build').toBe(true);
  // Pages that never started the observer (the RPC comparison, base builds) report no frames; only a refused start is an error.
  if(includeLongTaskTrace && includePhases) expect(loafObserved, 'long-animation-frame observer is not supported in the diagnostic browser').not.toBe(false);
  const rpcCalls = rpcInvocationsInWindow(rpcRawCalls, timeOrigin, boundary.startedAtMs, boundary.ms).map((call) => ({
    method: call.method,
    startedAtMs: call.startedAtEpochMs - timeOrigin - boundary.startedAtMs,
    durationMs: call.durationMs,
    outcome: call.outcome
  }));
  const rpcCallCount = metrics.rpcSpansRecorded ? rpcInvocationsInWindow(rpcInvocations, timeOrigin, boundary.startedAtMs, boundary.ms).length : metrics.rpcCallCount;
  const longTaskSummary = summarizeLongTaskWindow(longTasks, boundary.startedAtMs, boundary.ms);
  const rpcSummary = summarizeRpcTrace(rpcCalls, boundary.ms);
  return {
    ...metrics,
    rpcCallCount,
    ...(metrics.rpcSpansRecorded ? {rpcMethodCounts: rpcMethodCounts(rpcInvocations, timeOrigin, boundary.startedAtMs, boundary.ms)} : {}),
    rpcCalls,
    bundleBytes: sumBundleBytes(bundleResources, origin, boundary.startedAtMs, resourceCaptureEndedAt, resourceUrlBaseline),
    ...longTaskSummary,
    ...(includeLongTaskTrace ? {longTaskTrace: summarizeLongTaskTrace(longTasks, longAnimationFrames, boundary.startedAtMs, boundary.ms)} : {}),
    ...(scroll && includeLongTaskTrace ? {droppedFrameScripts: summarizeFrameScripts(summarizeDroppedFrames(frameWindows, [], []), longAnimationFrames)} : {}),
    ...(includePhases ? {reconcileMirrorTasks: summarizeReconcileMirrorTasks(reconcileMirrorTasks, boundary.startedAtMs, boundary.ms)} : {}),
    ms: boundary.ms,
    requests: requestCount,
    domNodes: boundary.domNodes,
    domClassCounts: boundary.domClassCounts,
    domNodeCounts: boundary.domNodeCounts,
    preInteractionMs: boundary.preInteractionMs,
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
    livePendingTraceIds: snapshot.workerPhases.filter(({durationMs}) => durationMs === null).map(({traceId}) => traceId),
    mainThreadTimeByTraceId: snapshot.mainThreadTimeByTraceId
  };
}

async function finalizeCachedDialogReconcileSummaries(page: Page, targets: CachedDialogReconcileTarget[]) {
  if(!targets.length) return;

  const readSnapshot = () => readCachedDialogReconcileSnapshot(page);

  let currentSnapshot = await readSnapshot();
  const mergePhases = () => {
    return settleInterruptedCachedDialogReconciles(mergeCachedDialogReconcilePhaseSnapshots([
      ...targets.map(({phaseSnapshots}) => phaseSnapshots),
      currentSnapshot.phases
    ]), currentSnapshot.livePendingTraceIds, targets.map(({pageStartedAtEpochMs}) => pageStartedAtEpochMs));
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
      !phase.interrupted &&
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

  const {scenarioStartedAtEpochMs, pageStartedAtEpochMs} = await page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    return {scenarioStartedAtEpochMs: performance.timeOrigin + perf.started, pageStartedAtEpochMs: performance.timeOrigin};
  });
  const scenarioEndedAtEpochMs = scenarioStartedAtEpochMs + metric.ms!;
  const phaseSnapshots = (await readCachedDialogReconcileSnapshot(page)).phases;
  targets.push({
    metric,
    scenario,
    scenarioStartedAtEpochMs,
    scenarioEndedAtEpochMs,
    pageStartedAtEpochMs,
    phaseSnapshots
  });
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
    const ms = performance.now() - perf.started;
    const elements = [...document.querySelectorAll('*')];
    const domClassCounts: Record<string, number> = {};
    for(const element of elements) for(const name of element.classList) {
      const key = `${element.tagName.toLowerCase()}.${name}`;
      domClassCounts[key] = (domClassCounts[key] || 0) + 1;
    }
    return {
      ms,
      startedAtMs: perf.started,
      domNodes: elements.length,
      domClassCounts,
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

async function installScrollSpanTracing(page: Page, required: boolean) {
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
    const dialogs = (window as any).appDialogsManager;
    wrap(dialogs, 'addListDialog', 'dialogs.addListDialog');
    wrap(dialogs, 'addDialogNew', 'dialogs.addDialogNew');
    wrap(dialogs?.xd, 'add', 'chatList.add');
    wrap(dialogs?.xd, 'update', 'chatList.update');
    wrap(dialogs?.xd, 'delete', 'chatList.delete');
    perf.scrollSpans = spans;
    perf.scrollSpanInstalled = installedNames;
    return installedNames;
  });
  // An empty span list reads as "no history call ran", so core hooks must install before scrolling starts.
  if(required) {
    expect(installed).toContain('bubbles.processBatch');
    expect(installed).toContain('bubbles.createScrollSaver');
  }
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

async function resetToChatList(page: Page, origin: string) {
  await page.goto(origin, {waitUntil: 'domcontentloaded'});
  await waitForChatList(page);
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

async function openPartnerChat(page: Page, requests: {value: number}, fixture: Fixture, traceRpc = false) {
  const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
  await expect(row).toBeVisible({timeout: 60_000});
  await begin(page, requests, true, traceRpc);
  await startMeasurementAtClick(row);
  await row.click();
  const boundary = await waitForFirstVisibleBubble(page);
  expect(Number.isFinite(boundary.preInteractionMs), 'chat-open timer did not start on the row click').toBe(true);
  return capture(page, requests, boundary, false, traceRpc);
}

async function scrollBackTwoThousand(page: Page, requests: {value: number}, required: boolean, options: ScrollBackTraceOptions = {}) {
  const {
    captureCpuStacks = false,
    captureFrameTrace = captureCpuStacks,
    captureWorkerMessages = captureCpuStacks,
    traceRpc = false,
    waitForHistory = false,
    includeLongTaskTrace = captureCpuStacks,
    onMeasurementBoundary
  } = options;
  const hasPendingHistory = () => page.evaluate(() => {
    const bubbles = (window as any).appImManager.chat.bubbles;
    return !!(bubbles.getHistoryTopPromise || bubbles.getHistoryBottomPromise);
  });

  // Only the diagnostic pass waits: the gated window must keep the chat-open history tail it always had.
  if(waitForHistory) await waitForHistorySettled(page);
  if(captureCpuStacks || captureFrameTrace) await installScrollSpanTracing(page, traceRpc);
  const frameTrace = captureFrameTrace ? await startFrameTrace(page) : undefined;
  await beginScenario(page, requests, traceRpc, captureWorkerMessages);
  if(includeLongTaskTrace) {
    const observed = await page.evaluate(() => (window as any).__teagramPerf.startLongAnimationFrames());
    expect(observed, 'long-animation-frame observer is not supported in the browser').toBe(true);
  }
  const cpuProfile = captureCpuStacks ? await startCpuProfile(page) : undefined;
  await page.evaluate((recordWindows) => (window as any).__teagramPerf.startFrames(recordWindows), captureFrameTrace);
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
  const boundary = await snapshotMeasurementBoundary(page);
  onMeasurementBoundary?.(boundary);
  const stoppedProfile = cpuProfile ? await stopCpuProfile(cpuProfile) : undefined;
  if(currentMin > targetMid) {
    await finishIncompleteScroll(
      `scroll reached message ${currentMin}, expected ${targetMid}: ${JSON.stringify(scrollState)}`,
      required,
      frameTrace ? () => stopFrameTrace(frameTrace) : undefined
    );
    return undefined;
  }
  const metric = await capture(page, requests, boundary, true, traceRpc, includeLongTaskTrace);
  const frameEvents = frameTrace ? await stopFrameTrace(frameTrace) : undefined;
  if(!stoppedProfile && !frameEvents && !captureWorkerMessages) return metric;
  const {tasks, spans, frameWindows, workerMessages, workerBatches} = await page.evaluate((captureWorkerMessages) => {
    const perf = (window as any).__teagramPerf;
    const workerMessages = captureWorkerMessages ? perf.workerMessages.spans : [];
    if(captureWorkerMessages) perf.workerMessages.restore();
    return {
      tasks: perf.longTasks as Array<{startTime: number, duration: number}>,
      spans: (perf.scrollSpans || []) as PerformanceSpan[],
      frameWindows: perf.frameWindows as Array<{startMs: number, endMs: number}>,
      workerMessages: workerMessages as Array<{type: string, startTime: number, duration: number, endTime?: number, messageCount?: number}>,
      workerBatches: (captureWorkerMessages ? perf.workerMessages.batches : []) as Array<{startTime: number, endTime: number, size: number}>
    };
  }, captureWorkerMessages);
  const windowEndMs = boundary.startedAtMs + boundary.ms;
  const windowTasks = tasks.filter(({startTime}) => startTime >= boundary.startedAtMs && startTime < windowEndMs);
  const workerAttribution = captureWorkerMessages ? {
    workerMessageAttribution: summarizeWorkerMessageAttribution(windowTasks, workerMessages, boundary.startedAtMs, workerBatches).map((task) => ({
      ...task, recorderReplayOverhead: recorderReplay || null
    }))
  } : {};
  const droppedFrameAttribution = frameTrace ? summarizeDroppedFrames(frameWindows, frameEvents || [], spans) : undefined;
  if(droppedFrameAttribution) expect(droppedFrameAttribution.reduce((sum, frame) => sum + frame.droppedFrames, 0), 'frame attribution must cover the measured drops').toBe(metric.droppedFrames || 0);
  if(!stoppedProfile) return {...metric, ...workerAttribution, ...(droppedFrameAttribution ? {droppedFrameAttribution} : {})};

  const tracing = await page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    return {
      installed: perf.scrollSpanInstalled || [],
      spanCount: (perf.scrollSpans || []).length,
      loafObserved: perf.loafObserved === true
    };
  });
  if(traceRpc) {
    expect(tracing.spanCount, 'scroll-back recorded no traced calls').toBeGreaterThan(0);
    expect(tracing.loafObserved, 'long-animation-frame observer is not supported in the diagnostic browser').toBe(true);
    expect(SCROLL_SPAN_NAMES.filter((name) => !tracing.installed.includes(name)), 'scroll-back tracing did not install every wrapped call').toEqual([]);
  }
  return {
    ...metric,
    ...workerAttribution,
    ...(droppedFrameAttribution ? {droppedFrameAttribution} : {}),
    scrollSpanTracing: tracing,
    ...(stoppedProfile ? {
      cpu: summarizeCpuProfile(stoppedProfile.profile),
      ...(droppedFrameAttribution ? {droppedFrameCpu: summarizeLongTaskAttribution(
        droppedFrameAttribution.map(({startMs, endMs}) => ({startTime: startMs, duration: endMs - startMs})),
        spans, stoppedProfile.profile, stoppedProfile.perfStartMs, boundary.startedAtMs, boundary.ms, 0
      )} : {}),
      longTaskAttribution: summarizeLongTaskAttribution(windowTasks, spans, stoppedProfile.profile, stoppedProfile.perfStartMs, boundary.startedAtMs, boundary.ms)
    } : {})
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
  const pageErrors: string[] = [];
  const recordPageError = (error: Error) => pageErrors.push(error.message);
  const recordWorkerRequest = (request: Request) => {
    if(request.url().includes('tlottie.worker')) workerRequests.push(request.url());
  };
  page.on('request', recordWorkerRequest);
  page.on('pageerror', recordPageError);
  try {
    await beginScenario(page, requests, traceEnabled);
    await page.locator('.sidebar-tools-button').click();
    await page.getByText('Contacts', {exact: true}).last().click();
    try {
      await expect(page.locator('#contacts-container .chatlist-chat').first()).toBeVisible({timeout: 60_000});
    } catch(error) {
      const dom = await getContactsFailureDetails(page);
      const contactsRpc = traceEnabled ? await getContactsRpcFailureDetails(page) : null;
      if(error instanceof Error) {
        error.message += `\nContacts diagnostics: ${JSON.stringify({dom, pageErrors, contactsRpc})}`;
      }
      throw error;
    }
    const boundary = await snapshotMeasurementBoundary(page);
    onMeasurementBoundary?.(boundary);
    const sample = await capture(page, requests, boundary, false, traceEnabled);
    expect(workerRequests).toEqual([]);
    return sample;
  } finally {
    page.off('request', recordWorkerRequest);
    page.off('pageerror', recordPageError);
  }
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

async function describeSendState(page: Page, fixture: Fixture) {
  const state = page.evaluate((partner) => {
    const chat = (window as any).appImManager?.chat;
    const input = document.querySelector('.input-message-input:not(.input-field-input-fake)');
    return {
      peerId: String(chat?.peerId ?? ''),
      peerChangeFailed: !!chat?.peerChangeFailed,
      partnerRows: document.querySelectorAll(`#chatlist-container .chatlist-chat[data-peer-id="${partner}"]`).length,
      chatRows: document.querySelectorAll('#chatlist-container .chatlist-chat').length,
      bubbles: document.querySelectorAll('#page-chats .bubbles .bubble[data-mid]').length,
      composer: input ? {editable: input.getAttribute('contenteditable'), hidden: !(input as HTMLElement).offsetParent} : null,
      pageClasses: document.querySelector('#page-chats')?.className
    };
  }, fixture.partner).catch((error: unknown) => ({evaluateError: String(error)}));
  return Promise.race([state, new Promise((resolve) => setTimeout(() => resolve('page unresponsive'), 5_000))]);
}

async function describeRow(row: Locator) {
  const sample = () => row.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity: style.opacity, visibility: style.visibility, transform: style.transform};
  }, undefined, {timeout: 5_000}).catch((error: unknown) => ({error: String(error)}));
  const first = await sample();
  await new Promise((resolve) => setTimeout(resolve, 200));
  return {first, second: await sample()};
}

async function installSendUiTiming(page: Page, text: string) {
  await page.evaluate((sendText) => {
    const composer = document.querySelector<HTMLElement>('.input-message-input:not(.input-field-input-fake)[contenteditable="true"]');
    const bubbles = document.querySelector<HTMLElement>('#page-chats .bubbles');
    if(!composer || !bubbles) throw new Error('send UI timing could not find the active composer and bubbles');

    const state: {startedAt: number | null, elapsedMs: number | null} = {startedAt: null, elapsedMs: null};
    const matchesBubble = (node: Node, searchDescendants = false) => {
      const element = node instanceof Element ? node : node.parentElement;
      if(!element) return false;
      const bubble = element.closest('.bubble.is-out') || (searchDescendants ? element.querySelector('.bubble.is-out') : null);
      return Boolean(bubble?.textContent?.includes(sendText));
    };
    const recordBubbleInsertion = (records: MutationRecord[]) => {
      if(state.startedAt === null || state.elapsedMs !== null) return;
      const matchingBubble = records.some((record) => {
        return [...record.addedNodes].some((node) => matchesBubble(node, true)) || matchesBubble(record.target);
      });
      if(matchingBubble) {
        state.elapsedMs = performance.now() - state.startedAt;
        observer.disconnect();
      }
    };
    const onKeydown = (event: KeyboardEvent) => {
      if(event.key !== 'Enter' || event.shiftKey || event.isComposing || state.startedAt !== null) return;
      state.startedAt = performance.now();
    };
    const observer = new MutationObserver(recordBubbleInsertion);
    observer.observe(bubbles, {childList: true, subtree: true, characterData: true});
    composer.addEventListener('keydown', onKeydown, true);
    (window as any).__teagramSendUiTiming = {
      state,
      cleanup: () => {
        observer.disconnect();
        composer.removeEventListener('keydown', onKeydown, true);
        delete (window as any).__teagramSendUiTiming;
      }
    };
  }, text);
}

async function finishSendUiTiming(page: Page) {
  const elapsedMs = await page.evaluate(() => {
    const timing = (window as any).__teagramSendUiTiming;
    if(!timing) return undefined;
    const {elapsedMs} = timing.state;
    timing.cleanup();
    return elapsedMs;
  });
  if(!Number.isFinite(elapsedMs)) throw new Error('in-page Enter-to-bubble timing did not observe the outgoing bubble');
  return elapsedMs as number;
}

async function sendMessage(page: Page, requests: {value: number}, fixture: Fixture, traceRpc = false, onMeasurementBoundary?: (boundary: MeasurementBoundary) => void) {
  let composerReadyAfterFirstBubbleMs = 0;
  let firstBubbleAtMs = 0;
  let appSendUiMs = 0;
  let cpu: PerformanceCpuSummary | undefined;
  try {
    const activeSearch = page.locator('#search-container.active');
    if(await activeSearch.count()) {
      await page.locator('#column-left .sidebar-back-button.is-visible').click();
      await expect(activeSearch).toHaveCount(0);
    }
    const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
    await expect(row).toBeVisible({timeout: 60_000});
    try {
      await row.click({timeout: 15_000});
    } catch(error) {
      console.warn('partner row never stabilised', JSON.stringify(await describeRow(row)), String(error).split('\n')[0]);
      throw error;
    }
    await expect(page.locator('#page-chats .bubbles .bubble[data-mid]').first()).toBeVisible();
    firstBubbleAtMs = await page.evaluate(() => performance.now());
    const composer = page.locator('.input-message-input:not(.input-field-input-fake)[contenteditable="true"]');
    // Deferred peer setup can finish after the first bubble is visible. Keep that readiness wait
    // reportable, but start the send-action clock only once the composer can accept input.
    await expect(composer).toBeVisible({timeout: 60_000});
    await expect(composer).toBeEditable({timeout: 60_000});
    composerReadyAfterFirstBubbleMs = await page.evaluate((startedAt) => performance.now() - startedAt, firstBubbleAtMs);
    const cpuProfile = traceRpc ? await startCpuProfile(page) : undefined;
    const text = `web-perf-${process.env.GITHUB_RUN_ID || 'local'}-${Date.now()}`;
    await installSendUiTiming(page, text);
    await beginScenario(page, requests, traceRpc);
    await composer.fill(text);
    await composer.press('Enter');
    await expect(page.locator('#page-chats .bubbles .bubble.is-out').filter({hasText: text})).toBeVisible({timeout: 60_000});
    appSendUiMs = await finishSendUiTiming(page);
    if(cpuProfile) cpu = await finishCpuProfile(cpuProfile);
  } catch(error) {
    console.error('send a message failed', JSON.stringify(await describeSendState(page, fixture)));
    throw error;
  }
  const firstBubbleToSentMs = await page.evaluate((startedAt) => performance.now() - startedAt, firstBubbleAtMs);
  const boundary = await snapshotMeasurementBoundary(page);
  onMeasurementBoundary?.(boundary);
  return {
    ...await capture(page, requests, boundary, false, traceRpc),
    appSendUiMs,
    composerReadyAfterFirstBubbleMs,
    firstBubbleToSentMs,
    ...(cpu ? {cpu} : {})
  };
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
    return await capture(page, requests, boundary);
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
    const coldChatList = await test.step('cold chat list', async() => capture(page, requests, await snapshotMeasurementBoundary(page)));
    measured.coldChatList.push(coldChatList);
    const warmChatList = await test.step('warm chat list', () => reloadChatList(page, requests));
    measured.warmChatList.push(warmChatList);

    const chatOpen = await test.step('open scale fixture chat', () => openPartnerChat(page, requests, fixture));
    measured.chatOpen.push(chatOpen);
    const scroll = await test.step('scroll back 2,000 messages', () => scrollBackTwoThousand(
      page,
      requests,
      variant === 'head',
      scale === '100x' ? {
        captureFrameTrace: true,
        captureCpuStacks: true,
        captureWorkerMessages: captureScrollAttribution,
        includeLongTaskTrace: true
      } : undefined
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
    await resetToChatList(page, origin);
    measured.contactsList.push(await test.step('open contacts', () => openContacts(page, requests)));
    measured.contactSearch.push(await test.step('search contacts', () => searchContacts(page, requests, scale)));
    measured.globalSearch.push(await test.step('global message search', () => globalSearch(page, requests, scale)));
    measured.sendMessage.push(await test.step('send a message', () => sendMessage(page, requests, fixture)));
  } finally {
    await context.close();
  }
}

async function runTimingRepeat(browser: Browser, run: VariantRun, fixture: Fixture) {
  const contextOptions = {
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  };
  let chatOpen: Metric;
  let scrollBack2k: Metric | undefined;

  const historyContext = await browser.newContext(contextOptions);
  try {
    const page = await historyContext.newPage();
    const requests = {value: 0};
    const captureWorkerMessages = run.variant === 'head';
    await installInstrumentation(page, requests, run.origin, false, captureWorkerMessages);
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    chatOpen = await openPartnerChat(page, requests, fixture);
    scrollBack2k = await scrollBackTwoThousand(page, requests, run.variant === 'head', {
      captureFrameTrace: true,
      captureCpuStacks: true,
      captureWorkerMessages,
      includeLongTaskTrace: true
    });
  } finally {
    await historyContext.close();
  }

  const sendContext = await browser.newContext(contextOptions);
  try {
    const page = await sendContext.newPage();
    const requests = {value: 0};
    await installInstrumentation(page, requests, run.origin);
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    const send = await sendMessage(page, requests, fixture);
    return {chatOpen, scrollBack2k: scrollBack2k || {bundleBytes: chatOpen.bundleBytes}, send};
  } finally {
    await sendContext.close();
  }
}

async function runSendTimingRepeat(browser: Browser, run: VariantRun, fixture: Fixture) {
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
    await waitForChatList(page);
    return await sendMessage(page, requests, fixture);
  } finally {
    await context.close();
  }
}

async function traceSendMessage(browser: Browser, run: VariantRun, fixture: Fixture) {
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
    await waitForChatList(page);
    return await sendMessage(page, requests, fixture, true);
  } finally {
    await context.close();
  }
}

async function traceChatOpen(browser: Browser, run: VariantRun, fixture: Fixture) {
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1280, height: 800}, storageState: run.storageState});
  try {
    const page = await context.newPage();
    const requests = {value: 0};
    await installInstrumentation(page, requests, run.origin);
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    return await openPartnerChat(page, requests, fixture, true);
  } finally {
    await context.close();
  }
}

async function traceTargetScenarios(browser: Browser, run: VariantRun, fixture: Fixture) {
  const traceSamples = Object.fromEntries(scenarios.map((scenario) => [scenario, [] as Metric[]])) as Record<string, Metric[]>;
  report.diagnostics['100x'] = traceSamples;

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
        await startMeasurementAtClick(row);
        await row.click();
        const chatOpenBoundary = await waitForFirstVisibleBubble(page);
        const chatCpu = await finishCpuProfile(chatProfile);
        const chatOpenCapture = await capture(page, requests, chatOpenBoundary, false, true);
        const chatOpenSample = {
          ...chatOpenCapture,
          cpu: chatCpu,
          peerChangePhases: summarizePerformancePhases(await page.evaluate(() => (window as any).__teagramPerf.peerChangePhases || []))
        };
        traceSamples.chatOpen.push(chatOpenSample);
        await addCachedDialogReconcileTarget(page, reconcileTargets, chatOpenSample, 'chatOpen');
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

        // Capture the date jump while the warm cached-dialog walk is still active, then profile history loading.
        let scrollBoundary: MeasurementBoundary | undefined;
        const scrolled = await test.step(`profile 100x scroll back 2,000 messages (repeat ${repeat + 1})`, () => scrollBackTwoThousand(page, requests, true, {
          captureCpuStacks: true,
          traceRpc: true,
          waitForHistory: true,
          onMeasurementBoundary: (boundary) => scrollBoundary = boundary
        }));
        if(!scrolled || !('cpu' in scrolled)) throw new Error('scroll-back profile did not reach 2,000 messages');
        expect(scrolled.rpcSpansRecorded, 'scroll-back RPC spans were not recorded').toBe(true);
        expect(scrolled.cpu.sampledCpuMs, 'scroll-back CPU profile was empty').toBeGreaterThan(0);
        if(!scrollBoundary) throw new Error('scroll-back measurement boundary was not recorded');
        traceSamples.scrollBack2k.push(scrolled);
        await addCachedDialogReconcileTarget(page, reconcileTargets, scrolled, 'scrollBack2k');

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
    const requireWalk = scenario === 'warmChatList' || scenario === 'chatOpen' || scenario === 'scrollBack2k' || scenario === 'dateJump';
    validateCachedDialogReconcileDiagnostics(traceSamples[scenario], scenario, expectedRepeatCount, requireWalk);
  }

  return traceSamples;
}

test('measures the scale fixture in interleaved base and head runs', async({browser}) => {
  expect(reportPath).toBeTruthy();
  measurementsStarted = true;

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

    for(let repeat = PERFORMANCE_TIMING_REPEATS; repeat < REPORT_ONLY_SEND_REPEATS; ++repeat) {
      const order = repeat % 2 === 0 ? timingVariants : [...timingVariants].reverse();
      for(const variant of order) {
        const run = preparedVariants['100x'][variant]!;
        const sample = await test.step(`100x ${variant} report-only send repeat ${repeat + 1}`, () => runSendTimingRepeat(browser, run, fixtures['100x']!));
        report.variants[variant]['100x'].sendMessage.push(sample);
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
  if(report.requireBase) {
    const baseTraceOrigin = process.env.PERF_TRACE_BASE_ORIGIN_100X;
    expect(baseTraceOrigin, '100x traced base origin is missing').toBeTruthy();
    const traceRuns = {
      base: withOrigin(preparedVariants['100x'].base!, 'base', baseTraceOrigin!),
      head: traceRun
    };
    const rpcComparison: Record<Variant, {chatOpen: Metric[], sendMessage: Metric[]}> = {
      base: {chatOpen: [], sendMessage: []},
      head: {chatOpen: [], sendMessage: []}
    };
    for(let repeat = 0; repeat < PERFORMANCE_REPEATS; ++repeat) {
      const order: Variant[] = repeat % 2 ? ['head', 'base'] : ['base', 'head'];
      for(const variant of order) {
        const chatOpen = await traceChatOpen(browser, traceRuns[variant], fixtures['100x']!);
        const sendMessage = await traceSendMessage(browser, traceRuns[variant], fixtures['100x']!);
        expect(chatOpen.rpcSpansRecorded && sendMessage.rpcSpansRecorded, `${variant} RPC spans were not recorded`).toBe(true);
        rpcComparison[variant].chatOpen.push(chatOpen);
        rpcComparison[variant].sendMessage.push(sendMessage);
      }
    }
    report.diagnostics['100x'].rpcComparison = rpcComparison;
  }

  const headScrollRepeats = report.variants.head['100x'].scrollBack2k;
  headScrollRepeats.forEach((metric) => {
    metric.longTaskTraceStatus = classifyMeasuredLongTaskTrace(metric);
    if(metric.longTaskAttribution) metric.historyPathTasks = selectHistoryPathTasks(metric.longTaskAttribution, SCROLL_SPAN_NAMES);
  });
  measurementsComplete = true;
});

test('blocks repeated injected 100 ms main-thread stalls during cold chat list load', async({browser}) => {
  test.skip(!report.requireBase, 'negative control requires same-run base measurements');
  const preparedHead = preparedVariants['100x'].head;
  expect(preparedHead, '100x head sign-in snapshot was not prepared').toBeTruthy();

  // Use the same bundle for both samples so a real improvement cannot mask the injected stall.
  const controlSamples: Metric[] = [];
  const negativeSamples: Metric[] = [];
  for(let repeat = 0; repeat < COLD_CHAT_LIST_REPEATS; ++repeat) {
    const order = repeat % 2 === 0 ? [false, true] : [true, false];
    for(const injectStall of order) {
      const {sample, injectedTask} = await measureColdControlWindow(browser, preparedHead!, injectStall);

      if(injectStall) {
        expect(sample.longTasksOver50Ms).toBeGreaterThan(0);
        expect(injectedTask?.duration).toBeGreaterThanOrEqual(100);
        expect(injectedTask?.observed).toBe(true);
        expect(sample.maxLongTaskDurationMs).toBeGreaterThanOrEqual(100);
        negativeSamples.push(sample);
      } else {
        controlSamples.push(sample);
      }
    }
  }
  const coldLoadEvaluation = evaluateWithControlSamples('coldChatList', controlSamples, negativeSamples);
  const coldLoadFailures = coldLoadEvaluation.blockingFailures.filter((failure) => failure.startsWith('100x coldChatList: '));
  const blockingTimes = (samples: Metric[]) => samples.map((sample) => sample.blockingTimeMs);
  expect(coldLoadFailures.some((failure) => failure.includes('long task') || failure.includes('blocking time')), `100 ms control was not blocked: control blocking ${JSON.stringify(blockingTimes(negativeSamples))} ms vs same-phase head ${JSON.stringify(blockingTimes(controlSamples))} ms`).toBe(true);
});
