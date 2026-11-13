import {installWorkerMessageAttribution, summarizeWorkerMessageAttribution} from './workerMessageAttribution';
import {readFileSync} from 'node:fs';
import {writePerformanceReport} from './performanceReport';
import {getServerRpcTracePosition, readServerRpcTraceRecordsSince, serverRpcRecordMatchesClientCall, serverRpcRecordMatchesClientCalls, serverRpcRecordsCoverClientCalls, serverRpcTraceExpectation, waitForServerRpcTraceRecords} from '../scripts/performance/server-rpc-trace.mjs';
import {expect, test, type Browser, type BrowserContext, type Locator, type Page, type Request} from '@playwright/test';
import Icons from '../src/icons';
import {COLD_CHAT_LIST_REPEATS, evaluatePerformance, PERFORMANCE_MEASUREMENT_VERSION, PERFORMANCE_REPEATS} from '../scripts/performance/policy.mjs';
import {createBundleRequestTracker, isNetworkRequestURL, sumBundleBytes, trackBundleDocumentNavigation, type BundleRequestTracker} from './performanceBundleBytes';
import {buildWalkComparison, CACHED_DIALOG_RECONCILE_PHASE_NAME, cachedDialogReconcileWindowMs, collectCachedDialogReconcileSummaries, findLongTasksOverlappingWalkMirrors, getScenarioPreservedPerformancePhases, mergeCachedDialogReconcilePhaseSnapshots, settleInterruptedCachedDialogReconciles, observeLongAnimationFrames, rpcInvocationsInWindow, rpcMethodCounts, summarizeCpuProfile, summarizeLongTaskAttribution, summarizeLongTaskTrace, summarizeLongTaskWindow, summarizePerformancePhases, summarizeReconcileMirrorTasks, summarizeRpcTrace, validateCachedDialogReconcileDiagnostics, type CachedDialogReconcilePhase, type CachedDialogReconcileSummary, type PerformanceCpuProfile, type PerformanceCpuSummary, type PerformancePhaseSummary, type PerformanceRpcCall, type PerformanceSpan, type PerformanceTaskAttribution, type ReconcileMirrorTask} from './performanceRpcTrace';
import {beginMeasurement as begin, finishIncompleteScroll, getContactsFailureDetails, getContactsRpcFailureDetails, observeFirstVisibleChatList, startMeasurementAtClick, waitForFirstVisibleBubble, waitForFirstVisibleChatList, type DomNodeCounts, type FirstVisibleChatListBoundary} from './performanceMeasurement';
import {startFrameTrace, stopFrameTrace, summarizeDroppedFrames, summarizeFrameScripts} from './performanceFrameTrace';
import {LOTTIE_FRAME_BG_CSS, scheduleAfterInterveningPaint, waitForFirstStickerFrame, waitForFirstStickerPaint, waitUntilOnScreen} from './lottieFrameMeasurement';
import {globalSearchSampleMs, isCurrentGlobalSearchResult} from '../scripts/performance/global-search-measurement.mjs';

type Fixture = {
  owner: number,
  partner: number,
  middle_date: number
};

type Scale = '1x' | '100x';
type Variant = 'base' | 'head';
type StickerVariant = Variant | 'pinned';
type ServerRpcTraceRecord = {
  method: string,
  duration_us: number,
  result: string,
  end_unix_ms: number
};
type ServerRpcClientCall = {
  callId: number,
  method: string,
  startedAtEpochMs: number,
  durationMs: number | null,
  outcome: 'pending' | 'success' | 'error'
};
type ServerRpcGateWindow = {
  startEpochMs: number,
  endEpochMs: number
};
type FirstStickerSample = {
  workerReadyBeforeChat: boolean,
  clickToFirstFrameMs: number,
  clickToVisibleFrameMs?: number,
  clickToWorkerRequestMs?: number,
  clickToNextPaintMs?: number,
  firstFrameToNextPaintMs?: number,
  pageTimestamps?: {clickAt: number, workerRequestAt: number, firstFrameAt: number, nextPaintAt: number}
};
const FIRST_STICKER_REPEATS = PERFORMANCE_REPEATS;
const FIRST_STICKER_REPORT_REPEATS = 3;
const TRACE_DIAGNOSTIC_REPEATS = 1;
const FIRST_STICKER_ASSET = '/assets/tgs/key.json';

type Metric = {
  ms: number,
  requests: number,
  requestBreakdown?: Record<string, number>,
  domNodes: number,
  domClassCounts: Record<string, number>,
  domNodeCounts: DomNodeCounts,
  bundleBytes: number,
  firstVisibleChatListMs?: number,
  firstVisibleChatListSource?: FirstVisibleChatListBoundary['source'],
  liveBoundaryMs?: number,
  longTasksOver50Ms: number,
  blockingTimeMs: number,
  maxLongTaskDurationMs: number,
  rpcCallCount: number,
  rpcMethodCounts?: Record<string, number>,
  rpcWallMs: number | null,
  nonRpcElapsedMs: number | null,
  serverRpcRecords?: ServerRpcTraceRecord[],
  serverRpcClientCalls?: ServerRpcClientCall[],
  serverRpcGateWindow?: ServerRpcGateWindow,
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
  scrollSpanTracing?: {installed: string[], spanCount: number, loafObserved: boolean},
  droppedFramePercent?: number,
  droppedFrames?: number,
  frameIntervals?: number,
  rafDropped?: number,
  droppedFrameAttribution?: ReturnType<typeof summarizeDroppedFrames>,
  droppedFrameCpu?: PerformanceTaskAttribution[],
  droppedFrameScripts?: ReturnType<typeof summarizeFrameScripts>,
  longTaskTrace?: ReturnType<typeof summarizeLongTaskTrace>,
  walkLongTasksOver50Ms?: number,
  reconcileMirrorTasks?: ReconcileMirrorTask[],
  preInteractionMs?: number,
  appSendUiMs?: number,
  composerReadyAfterFirstBubbleMs?: number,
  firstBubbleToSentMs?: number,
  globalSearchStages?: {
    queryEnteredAtMs: number,
    debounceSettledAtMs: number,
    matchingSearchRpcReturnedAtMs: number,
    matchingResultVisibleAtMs: number
  }
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
  firstVisibleChatListMs?: number,
  firstVisibleChatListSource?: FirstVisibleChatListBoundary['source'],
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
  pauseLongAnimationFrames?: boolean,
  includeLongTaskTrace?: boolean,
  collectWalkDiagnostics?: boolean,
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
const serverRpcTraceFile = process.env.PERF_SERVER_RPC_TRACE_FILE_100X;
let recorderReplay: unknown;
try {
  if(recorderReplayPath) recorderReplay = JSON.parse(readFileSync(recorderReplayPath, 'utf8'));
} catch{
  // The replay gate reports missing or failed measurements.
}
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
let firstStickerPinnedRun: VariantRun | undefined;
const bundleRequestTrackers = new WeakMap<Page, BundleRequestTracker>();
const requestBreakdownsByPage = new WeakMap<Page, Map<string, number>>();
const serverRpcTraceOffsetsBySample = new WeakMap<Metric, number | undefined>();

const scenarios = ['coldChatList', 'warmChatList', 'chatOpen', 'scrollBack2k', 'dateJump', 'contactsList', 'contactSearch', 'globalSearch', 'sendMessage'];
const scenarioPreservedPerformancePhases = getScenarioPreservedPerformancePhases();
let measurementsStarted = false;
let measurementsComplete = false;

function serverRpcTraceOffset() {
  if(!serverRpcTraceFile) {
    if(report.requireBase) throw new Error('100x server RPC trace file path is missing');
    return undefined;
  }
  return getServerRpcTracePosition(serverRpcTraceFile);
}

async function attachServerRpcTrace(sample: Metric, offset: number | undefined, expectedCount?: number) {
  if(offset === undefined) return sample;
  const clientCalls = sample.serverRpcClientCalls;
  if(!Array.isArray(clientCalls) || !clientCalls.length) {
    throw new Error('100x chat-open sample has no client messages.getHistory spans to correlate');
  }
  const expectation = serverRpcTraceExpectation(expectedCount);
  let records: ServerRpcTraceRecord[];
  try {
    records = await waitForServerRpcTraceRecords(
      serverRpcTraceFile!,
      offset,
      'messages.getHistory',
      expectation.minimumCount,
      {quietMs: 150, recordFilter: (record) => serverRpcRecordMatchesClientCalls(record, clientCalls)}
    );
  } catch(error) {
    const traceRecords = readServerRpcTraceRecordsSince(serverRpcTraceFile!, offset).filter((record) => record.method === 'messages.getHistory');
    const correlation = {
      clientCalls: clientCalls.map((call, callIndex) => ({
        callIndex,
        startedAtEpochMs: call.startedAtEpochMs,
        durationMs: call.durationMs,
        outcome: call.outcome,
        matchingRecordIndexes: traceRecords.flatMap((record, recordIndex) => (
          serverRpcRecordMatchesClientCall(record, call) ? [recordIndex] : []
        ))
      })),
      serverRecords: traceRecords.map((record, recordIndex) => ({
        recordIndex,
        end_unix_ms: record.end_unix_ms,
        duration_us: record.duration_us,
        result: record.result,
        matchingCallIndexes: clientCalls.flatMap((call, callIndex) => (
          serverRpcRecordMatchesClientCall(record, call) ? [callIndex] : []
        ))
      }))
    };
    throw new Error(`${String(error)}; RPC sample correlation ${JSON.stringify(correlation)}`);
  }
  if(!serverRpcRecordsCoverClientCalls(records, clientCalls)) {
    throw new Error('100x chat-open server records do not cover every client messages.getHistory span');
  }
  const serverRpcRecords = records;
  if(!serverRpcRecords.length) throw new Error('100x chat-open measurement has no server messages.getHistory duration records');
  return {...sample, serverRpcRecords};
}

test.afterAll(() => {
  if(!measurementsStarted) return;
  if(measurementsComplete) {
    scenarios.forEach((scenario) => {
      const diagnosticSamples = report.diagnostics['100x']?.[scenario];
      if(!Array.isArray(diagnosticSamples)) return;
      diagnosticSamples.forEach((sample) => {
        const metric = sample as Metric;
        metric.walkLongTasksOver50Ms = findLongTasksOverlappingWalkMirrors(metric.longTaskTrace, metric.reconcileMirrorTasks).length;
      });
    });
  }
  if(reportPath) writePerformanceReport(reportPath, report);
});

async function installInstrumentation(page: Page, requestCounter: {value: number}, origin: string, injectColdStall = false, observeAnimationFrames = false, recordWorkerMessages = observeAnimationFrames, recordLottieWorkerRequest = false) {
  const bundleRequests = createBundleRequestTracker(new URL(origin).origin);
  const requestBreakdown = new Map<string, number>();
  bundleRequestTrackers.set(page, bundleRequests);
  requestBreakdownsByPage.set(page, requestBreakdown);
  trackBundleDocumentNavigation(page, bundleRequests);
  page.on('request', (request) => {
    const requestUrl = request.url();
    if(isNetworkRequestURL(requestUrl)) {
      ++requestCounter.value;
      const url = new URL(requestUrl);
      const path = url.pathname;
      const key = `${request.method()} ${request.resourceType()} ${path}`;
      requestBreakdown.set(key, (requestBreakdown.get(key) || 0) + 1);
    }
    bundleRequests.requestStarted(request);
  });
  page.on('requestfinished', (request) => bundleRequests.requestFinished(request));
  page.on('requestfailed', (request) => bundleRequests.requestFailed(request));
  page.on('worker', (worker) => bundleRequests.workerReady(worker.url()));
  await page.exposeBinding('__teagramBundleWorkerReady', (_source, url: string) => bundleRequests.workerReady(url));
  await page.addInitScript({content: `window.__teagramIsCurrentGlobalSearchResult = (${isCurrentGlobalSearchResult.toString()});`});
  // The gated scroll pauses this observer while it records RAF gaps.
  await page.addInitScript({content: `window.__teagramObserveLongAnimationFrames = ${observeLongAnimationFrames.toString()};`});
  if(recordWorkerMessages) await page.addInitScript({content: `window.__teagramInstallWorkerMessageAttribution = ${installWorkerMessageAttribution.toString()};`});
  if(recordLottieWorkerRequest) {
    await page.addInitScript({content: `window.__teagramScheduleAfterInterveningPaint = ${scheduleAfterInterveningPaint.toString()};`});
  }
  await page.addInitScript(({injectColdStall, observeAnimationFrames, recordLottieWorkerRequest}: {injectColdStall: boolean, observeAnimationFrames: boolean, recordLottieWorkerRequest: boolean}) => {
    const recordWorkerRequest = recordLottieWorkerRequest ? (url: unknown) => {
      if(!String(url).includes('tlottie.worker')) return;
      const perf = (window as any).__teagramPerf;
      if(!perf || Number.isFinite(perf.firstStickerWorkerRequestAt)) return;
      const workerRequestAt = performance.now();
      perf.firstStickerWorkerRequestAt = workerRequestAt;
      const stickerTiming = (window as any).__performanceFirstStickerPaintTiming;
      if(stickerTiming) stickerTiming.workerRequestAt = workerRequestAt;
    } : undefined;
    // Playwright does not emit a page worker event for SharedWorker; use its first port message as the ready signal.
    const SharedWorkerConstructor = (window as any).SharedWorker;
    if(SharedWorkerConstructor) {
      (window as any).SharedWorker = new Proxy(SharedWorkerConstructor, {
        construct(target, args, newTarget) {
          recordWorkerRequest?.(args[0]);
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
    if(recordLottieWorkerRequest) {
      const WorkerConstructor = (window as any).Worker;
      if(WorkerConstructor) {
        (window as any).Worker = new Proxy(WorkerConstructor, {
          construct(target, args, newTarget) {
            recordWorkerRequest?.(args[0]);
            return Reflect.construct(target, args, newTarget);
          }
        });
      }
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
      frameStartMs: undefined as number | undefined,
      frameEndMs: undefined as number | undefined,
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
      const wasActive = Boolean(longAnimationFrameObserver);
      longAnimationFrameObserver?.disconnect();
      longAnimationFrameObserver = undefined;
      return wasActive;
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
      perf.frameStartMs = performance.now();
      perf.frameEndMs = undefined;
      perf.lastFrame = perf.frameStartMs;
      const sampleFrame = (time: number) => {
        if(!perf.frameActive) return;
        perf.frameIntervals.push(time - perf.lastFrame);
        if(recordWindows) perf.frameWindows.push({startMs: perf.lastFrame, endMs: time});
        perf.lastFrame = time;
        requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);
    };
    perf.stopFrames = () => {
      perf.frameEndMs = performance.now();
      perf.frameActive = false;
    };
  }, {injectColdStall, observeAnimationFrames, recordLottieWorkerRequest});
  return page.addInitScript({content: `(${observeFirstVisibleChatList.toString()})();`});
}

async function waitForBundleResources(page: Page) {
  const bundleRequests = bundleRequestTrackers.get(page);
  if(!bundleRequests) throw new Error('Bundle request tracking was not installed for this page');
  await bundleRequests.waitForIdle(500, 10_000);
}

async function waitForLottieWorker(page: Page) {
  await expect.poll(() => page.evaluate(() => (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).some((entry) => (
    entry.name.includes('tlottie.worker') && entry.responseEnd > 0
  ))), {
    message: 'Lottie worker did not finish loading before the warm first-sticker measurement',
    timeout: 30_000,
    intervals: [100]
  }).toBe(true);
  await waitForBundleResources(page);
}

function resetRequestBreakdown(page: Page) {
  requestBreakdownsByPage.get(page)?.clear();
}

async function beginScenario(page: Page, requests: {value: number}, traceEnabled = false, captureWorkerMessages = false) {
  resetRequestBreakdown(page);
  await begin(page, requests, true, traceEnabled, captureWorkerMessages);
  if(!traceEnabled) return;
  await page.evaluate((preserveNames) => (window as any).rootScope.managers.apiManager.resetPerformancePhaseTrace(preserveNames), scenarioPreservedPerformancePhases);
  await page.evaluate(() => (window as any).__teagramPerf.startLongAnimationFrames());
}

async function capture(page: Page, requests: {value: number}, boundary: MeasurementBoundary, scroll = false, includePhases = false, includeLongTaskTrace = includePhases, includeRequestBreakdown = false, collectWalkDiagnostics = false, captureRpcTrace = includePhases, captureServerRpcClientCalls = false): Promise<Metric> {
  const requestCount = requests.value;
  const requestBreakdownByPath = requestBreakdownsByPage.get(page);
  const requestBreakdown = requestBreakdownByPath ? Object.fromEntries([...requestBreakdownByPath].sort(([left], [right]) => left.localeCompare(right))) : undefined;
  requestBreakdownByPath?.clear();
  if(includeRequestBreakdown) expect(Object.values(requestBreakdown || {}).reduce((total, count) => total + count, 0)).toBe(requestCount);
  await page.waitForTimeout(150);
  await waitForBundleResources(page);
  const captured = await page.evaluate(async({scroll, includePhases, includeLongTaskTrace, collectWalkDiagnostics, captureRpcTrace}) => {
    const perf = (window as any).__teagramPerf;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const resourceCaptureEndedAt = performance.now();
    const intervals = scroll ? perf.frameIntervals : [];
    const droppedFrames = intervals.reduce((total: number, interval: number) => total + Math.max(0, Math.round(interval / (1000 / 60)) - 1), 0);
    const droppedFramePercent = intervals.length ? droppedFrames / (droppedFrames + intervals.length) * 100 : 0;
    const longTasks = perf.longTasks.filter((entry: {startTime: number}) => entry.startTime >= perf.started);
    const apiManager = (window as any).rootScope.managers.apiManager;
    const rpcTrace = captureRpcTrace ? await apiManager.getPerformanceRpcTrace() as {
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
      reconcileMirrorTasks: includePhases || collectWalkDiagnostics ? perf.cachedDialogsReconcileMirrorTasks.slice() : [],
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
      frameIntervals: scroll && intervals.length ? intervals.length : undefined,
      rafDropped: scroll && intervals.length ? droppedFrames : undefined
    };
  }, {scroll, includePhases, includeLongTaskTrace, collectWalkDiagnostics, captureRpcTrace});
  const {bundleResources, origin, resourceCaptureEndedAt, resourceUrlBaseline, longTasks, longAnimationFrames, frameWindows, reconcileMirrorTasks, loafObserved, rpcInvocations, rpcRawCalls, timeOrigin, ...metrics} = captured;
  if(captureRpcTrace) expect(metrics.rpcTraceEnabled, 'performance RPC trace flag was not enabled in the diagnostic client build').toBe(true);
  if(captureServerRpcClientCalls) expect(captureRpcTrace && metrics.rpcSpansRecorded, 'server RPC correlation requires recorded client spans').toBe(true);
  // Lightweight walk counts need long tasks only; non-scroll samples may not start the animation-frame observer.
  if(includeLongTaskTrace && includePhases) expect(loafObserved, 'long-animation-frame observer is not supported in the diagnostic browser').not.toBe(false);
  const rpcCalls = rpcInvocationsInWindow(rpcRawCalls, timeOrigin, boundary.startedAtMs, boundary.ms).map((call) => ({
    method: call.method,
    startedAtMs: call.startedAtEpochMs - timeOrigin - boundary.startedAtMs,
    durationMs: call.durationMs,
    outcome: call.outcome
  }));
  // Spans are append-only between trace resets and the reset precedes the click, so a span's position in the
  // trace identifies it. The app trace carries no call id, and base bundles must not need one.
  const serverRpcClientCalls = captureServerRpcClientCalls
    ? rpcInvocationsInWindow(rpcRawCalls.map((call, callId) => ({...call, callId})).filter((call) => call.method === 'messages.getHistory'), timeOrigin, boundary.startedAtMs, boundary.ms)
    : undefined;
  const serverRpcGateWindow = captureServerRpcClientCalls ? {
    startEpochMs: timeOrigin + boundary.startedAtMs,
    endEpochMs: timeOrigin + boundary.startedAtMs + boundary.ms
  } : undefined;
  const rpcCallCount = metrics.rpcSpansRecorded ? rpcInvocationsInWindow(rpcInvocations, timeOrigin, boundary.startedAtMs, boundary.ms).length : metrics.rpcCallCount;
  const longTaskSummary = summarizeLongTaskWindow(longTasks, boundary.startedAtMs, boundary.ms);
  const rpcSummary = summarizeRpcTrace(rpcCalls, boundary.ms);
  const longTaskTrace = includeLongTaskTrace || collectWalkDiagnostics
    ? summarizeLongTaskTrace(longTasks, includeLongTaskTrace ? longAnimationFrames : [], boundary.startedAtMs, boundary.ms)
    : undefined;
  const reconcileMirrorSummaries = includePhases || collectWalkDiagnostics ? summarizeReconcileMirrorTasks(reconcileMirrorTasks, boundary.startedAtMs, boundary.ms) : undefined;
  return {
    ...metrics,
    rpcCallCount,
    ...(metrics.rpcSpansRecorded ? {rpcMethodCounts: rpcMethodCounts(rpcInvocations, timeOrigin, boundary.startedAtMs, boundary.ms)} : {}),
    rpcCalls,
    ...(serverRpcClientCalls ? {serverRpcClientCalls} : {}),
    ...(serverRpcGateWindow ? {serverRpcGateWindow} : {}),
    bundleBytes: sumBundleBytes(bundleResources, origin, boundary.startedAtMs, resourceCaptureEndedAt, resourceUrlBaseline),
    ...longTaskSummary,
    ...(includeLongTaskTrace || collectWalkDiagnostics ? {longTaskTrace} : {}),
    ...(scroll && includeLongTaskTrace ? {droppedFrameScripts: summarizeFrameScripts(summarizeDroppedFrames(frameWindows, [], []), longAnimationFrames)} : {}),
    ...(includePhases || collectWalkDiagnostics ? {reconcileMirrorTasks: reconcileMirrorSummaries} : {}),
    ...(collectWalkDiagnostics ? {walkLongTasksOver50Ms: findLongTasksOverlappingWalkMirrors(longTaskTrace, reconcileMirrorSummaries).length} : {}),
    ms: boundary.firstVisibleChatListMs ?? boundary.ms,
    ...(boundary.firstVisibleChatListMs !== undefined ? {
      firstVisibleChatListMs: boundary.firstVisibleChatListMs,
      firstVisibleChatListSource: boundary.firstVisibleChatListSource,
      liveBoundaryMs: boundary.ms
    } : {}),
    requests: requestCount,
    ...(includeRequestBreakdown ? {requestBreakdown} : {}),
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

async function waitForCachedDialogReconcileBeforeNavigation(page: Page) {
  await expect.poll(async() => (await readCachedDialogReconcileSnapshot(page)).livePendingTraceIds, {
    message: 'cached dialog reconciliation did not finish before the diagnostic page navigation',
    timeout: 120_000,
    intervals: [100]
  }).toEqual([]);
}

async function addCachedDialogReconcileTarget(page: Page, targets: CachedDialogReconcileTarget[] | undefined, metric: Partial<Metric>, scenario: string) {
  if(!targets) return;
  expect(Number.isFinite(metric.ms), `${scenario} measurement duration is missing`).toBe(true);

  const {scenarioStartedAtEpochMs, pageStartedAtEpochMs} = await page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    return {scenarioStartedAtEpochMs: performance.timeOrigin + perf.started, pageStartedAtEpochMs: performance.timeOrigin};
  });
  const scenarioEndedAtEpochMs = scenarioStartedAtEpochMs + cachedDialogReconcileWindowMs(metric)!;
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
      wrap(chat.bubbles?.scrollable, 'replaceChildren', 'scrollable.replaceChildren');
      // These split the time between mounting the chat and the first bubble appearing.
      wrap(chat.bubbles, 'safeRenderMessage', 'bubbles.safeRenderMessage');
      wrap(chat.bubbles, 'renderMessagesQueue', 'bubbles.renderMessagesQueue');
    };
    wrap(chat, 'setPeer', 'chat.setPeer');
    wrap(chat, 'onChangePeer', 'chat.onChangePeer');
    wrap(chat, 'finishPeerChange', 'chat.finishPeerChange');
    // A chat built ahead of the first open has no `init` left, and putting one back would build it twice.
    if(typeof chat.init === 'function') {
      wrap(chat, 'init', 'chat.init');
      const originalInit = chat.init;
      chat.init = function(...args: any[]) {
        const result = originalInit.apply(this, args);
        wrapPeerChangeParts();
        return result;
      };
    }
    wrapPeerChangeParts();
    perf.peerChangePhases = phases;
    perf.peerChangeBase = base;
    const mark = (name: string) => phases.push({name, startMs: performance.now() - base, durationMs: 0});
    const im = (window as any).appImManager;
    wrap(im, 'setPeer', 'im.setPeer');
    wrap(im, 'setInnerPeer', 'im.setInnerPeer');
    wrap(chat, 'revealPreparedBackground', 'chat.revealPreparedBackground');
    const observer = new MutationObserver(() => {
      if(document.querySelector('.bubbles .bubble[data-mid]')) {
        mark('dom.firstBubbleInserted');
        observer.disconnect();
      }
    });
    observer.observe(document.body, {childList: true, subtree: true});
    document.addEventListener('click', () => mark('click'), {capture: true, once: true});
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

async function snapshotMeasurementBoundary(page: Page, firstVisibleChatList?: FirstVisibleChatListBoundary): Promise<MeasurementBoundary> {
  const boundary = await page.evaluate(() => {
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
  return {
    ...boundary,
    ...(firstVisibleChatList ? {
      firstVisibleChatListMs: firstVisibleChatList.ms,
      firstVisibleChatListSource: firstVisibleChatList.source
    } : {})
  };
}

async function captureScenario(
  page: Page,
  requests: {value: number},
  traceEnabled = false,
  onMeasurementBoundary?: (boundary: MeasurementBoundary) => void,
  collectWalkDiagnostics = false
) {
  const boundary = await snapshotMeasurementBoundary(page);
  onMeasurementBoundary?.(boundary);
  return capture(page, requests, boundary, false, traceEnabled, traceEnabled || collectWalkDiagnostics, false, collectWalkDiagnostics);
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

async function waitForChatList(page: Page): Promise<FirstVisibleChatListBoundary> {
  const firstVisible = await waitForFirstVisibleChatList(page);
  const timeout = 120_000;
  await expect(page.locator('.chat-page-snapshot')).toHaveCount(0, {timeout});
  await expect(page.locator('#page-chats #folders-container .chatlist-chat').first()).toBeVisible({timeout});
  return firstVisible;
}

async function resetToChatList(page: Page, origin: string) {
  await page.goto(origin, {waitUntil: 'domcontentloaded'});
  await waitForChatList(page);
}

async function waitForHistorySettled(page: Page) {
  let previousDomNodes = -1;
  let stableSamples = 0;
  await expect.poll(async() => {
    const state = await page.evaluate(async() => {
      const bubbles = (window as any).appImManager.chat.bubbles;
      // The manager proxy returns a promise, so the trace has to be awaited before its spans can be read.
      const rpcCalls = (await (window as any).rootScope.managers.apiManager.getPerformanceRpcTrace())?.calls;
      return {
        pending: !!(bubbles?.getHistoryTopPromise || bubbles?.getHistoryBottomPromise) || (Array.isArray(rpcCalls) && rpcCalls.some((call: {method: string, outcome: string}) => (
          call.method === 'messages.getHistory' && call.outcome === 'pending'
        ))),
        domNodes: document.querySelectorAll('*').length
      };
    });
    stableSamples = !state.pending && state.domNodes === previousDomNodes ? stableSamples + 1 : 0;
    previousDomNodes = state.domNodes;
    return stableSamples >= 2;
  }, {timeout: 60_000, intervals: [100]}).toBe(true);
}

async function prepareChatOpenStartState(page: Page, fixture: Fixture) {
  const otherRow = page.locator(`#chatlist-container .chatlist-chat[data-peer-id]:not([data-peer-id="${fixture.partner}"])`).first();
  await expect(otherRow, '100x chat-open requires another chat to leave before opening the fixture peer').toBeVisible({timeout: 60_000});
  const otherPeerId = await otherRow.getAttribute('data-peer-id');
  if(!otherPeerId || otherPeerId === String(fixture.partner)) throw new Error('100x chat-open could not select a different starting peer');
  await otherRow.click();
  await expect.poll(() => page.evaluate(() => String((window as any).appImManager.chat.peerId)), {timeout: 60_000}).toBe(otherPeerId);
  await waitForHistorySettled(page);
  await page.evaluate(async(peerId) => (window as any).rootScope.managers.appMessagesManager.flushStoragesByPeerId(peerId), fixture.partner);
}

async function finalizeServerRpcTrace(page: Page, sample: Metric) {
  const offset = serverRpcTraceOffsetsBySample.get(sample);
  if(offset === undefined) return sample;

  const boundaryCalls = sample.serverRpcClientCalls;
  if(!Array.isArray(boundaryCalls)) throw new Error('100x chat-open sample has no boundary client RPC identities');
  const callIds = boundaryCalls.map((call) => call.callId);
  if(callIds.some((callId) => !Number.isSafeInteger(callId)) || new Set(callIds).size !== callIds.length) {
    throw new Error(`100x chat-open sample has invalid or duplicate client RPC identities: ${JSON.stringify(callIds)}`);
  }
  let clientCalls: ServerRpcClientCall[] = [];
  await expect.poll(async() => {
    clientCalls = await page.evaluate(async(ids) => {
      const trace = await (window as any).rootScope.managers.apiManager.getPerformanceRpcTrace();
      const calls = trace.calls as Array<Omit<ServerRpcClientCall, 'callId'>>;
      return ids.flatMap((callId) => {
        const call = calls[callId];
        return call ? [{...call, callId}] : [];
      });
    }, callIds);
    return clientCalls.length === callIds.length && clientCalls.every((call) => call.outcome !== 'pending' && Number.isFinite(call.durationMs));
  }, {timeout: 60_000, intervals: [20]}).toBe(true);
  sample.serverRpcClientCalls = clientCalls;
  Object.assign(sample, await attachServerRpcTrace(sample, offset, clientCalls.length));
  return sample;
}

async function reloadChatList(page: Page, requests: {value: number}, collectWalkDiagnostics = false) {
  resetRequestBreakdown(page);
  await begin(page, requests);
  await page.reload({waitUntil: 'domcontentloaded'});
  const firstVisibleChatList = await waitForChatList(page);
  expect(firstVisibleChatList.source).toBe('snapshot');
  return capture(page, requests, await snapshotMeasurementBoundary(page, firstVisibleChatList), false, false, collectWalkDiagnostics, true, collectWalkDiagnostics);
}

async function openPartnerChat(page: Page, requests: {value: number}, fixture: Fixture, traceRpc = false, collectWalkDiagnostics = false, collectServerRpcTrace = false) {
  const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
  await expect(row).toBeVisible({timeout: 60_000});
  if(collectServerRpcTrace) await prepareChatOpenStartState(page, fixture);
  resetRequestBreakdown(page);
  await begin(page, requests, true, traceRpc);
  await startMeasurementAtClick(row);
  const traceOffset = collectServerRpcTrace ? serverRpcTraceOffset() : undefined;
  await row.click();
  const boundary = await waitForFirstVisibleBubble(page);
  expect(Number.isFinite(boundary.preInteractionMs), 'chat-open timer did not start on the row click').toBe(true);
  const sample = await capture(page, requests, boundary, false, false, collectWalkDiagnostics, false, collectWalkDiagnostics, traceRpc, collectServerRpcTrace);
  if(!collectServerRpcTrace) return sample;
  serverRpcTraceOffsetsBySample.set(sample, traceOffset);
  return sample;
}

async function scrollBackTwoThousand(page: Page, requests: {value: number}, required: boolean, options: ScrollBackTraceOptions = {}) {
  const {
    captureCpuStacks = false,
    captureFrameTrace = captureCpuStacks,
    captureWorkerMessages = captureCpuStacks,
    traceRpc = false,
    waitForHistory = false,
    pauseLongAnimationFrames = false,
    includeLongTaskTrace = captureCpuStacks,
    collectWalkDiagnostics = false,
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
  const resumeLongAnimationFrames = pauseLongAnimationFrames ? await page.evaluate(() => (window as any).__teagramPerf.stopLongAnimationFrames()) : false;
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
  if(resumeLongAnimationFrames) await page.evaluate(() => (window as any).__teagramPerf.startLongAnimationFrames());
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
  const metric = {
    ...await capture(page, requests, boundary, true, traceRpc, includeLongTaskTrace, false, collectWalkDiagnostics)
  };
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
  traceEnabled = false,
  onMeasurementBoundary?: (boundary: MeasurementBoundary) => void,
  collectWalkDiagnostics = false
): Promise<Metric> {
  await beginScenario(page, requests, traceEnabled);
  const beforeMids = await page.locator('.bubbles .bubble[data-mid]').evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).dataset.mid)));
  const searchIcon = String.fromCharCode(parseInt(Icons.search, 16));
  await page.locator('#page-chats .chat-utils > .btn-icon').filter({hasText: searchIcon}).click();
  const calendarIcon = String.fromCharCode(parseInt(Icons.calendar, 16));
  const searchCalendar = page.locator('#page-chats .topbar-search-container .topbar-search-right-filter > .btn-icon').filter({hasText: calendarIcon});
  await expect(page.locator('#page-chats .topbar-search-container')).toBeVisible();
  if(!await searchCalendar.count()) {
    throw new Error('date-jump calendar control is missing from the measured build');
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
  return captureScenario(page, requests, traceEnabled, onMeasurementBoundary, collectWalkDiagnostics);
}

async function openContacts(page: Page, requests: {value: number}, variant: Variant, traceEnabled = false, onMeasurementBoundary?: (boundary: MeasurementBoundary) => void, collectWalkDiagnostics = false) {
  if(variant === 'base') {
    // The base may already include lazy Lottie worker loading; only settle resources that actually started.
    await waitForBundleResources(page);
  }

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
    const toolsButton = page.locator('.sidebar-tools-button');
    await toolsButton.click();
    await expect(toolsButton).toHaveClass(/menu-open/, {timeout: 10_000});
    const toolsMenu = page.locator('.btn-menu.active');
    await expect(toolsMenu).toBeVisible({timeout: 10_000});
    await toolsMenu.getByText('Contacts', {exact: true}).click();
    try {
      await expect(page.locator('#contacts-container')).toBeVisible({timeout: 10_000});
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
    const sample = await capture(page, requests, boundary, false, traceEnabled, traceEnabled || collectWalkDiagnostics, false, collectWalkDiagnostics);
    if(variant === 'base') expect(workerRequests).toEqual([]);
    return sample;
  } finally {
    page.off('request', recordWorkerRequest);
    page.off('pageerror', recordPageError);
  }
}

async function searchContacts(page: Page, requests: {value: number}, scale: Scale, traceEnabled = false, onMeasurementBoundary?: (boundary: MeasurementBoundary) => void, collectWalkDiagnostics = false) {
  await beginScenario(page, requests, traceEnabled);
  const input = page.locator('#contacts-container .input-search-input');
  await input.fill(scale === '1x' ? 'k00099' : 'k09999');
  await expect(page.locator('#contacts-container .chatlist-chat').first()).toBeVisible({timeout: 60_000});
  await expect(page.locator('#contacts-container .chatlist-chat')).toHaveCount(1, {timeout: 60_000});
  return captureScenario(page, requests, traceEnabled, onMeasurementBoundary, collectWalkDiagnostics);
}

async function waitForGlobalSearchResult(page: Page, query: string, recordTimestamp: boolean) {
  await page.waitForFunction(({query, recordTimestamp}) => {
    const perf = (window as any).__teagramPerf;
    const stages = perf?.globalSearchStages;
    if(recordTimestamp && (!Number.isFinite(stages?.queryEnteredAtMs) || !Number.isFinite(stages?.debounceSettledAtMs))) return false;
    const input = document.querySelector<HTMLInputElement>('#column-left .item-main .sidebar-header .input-search-input');
    if(input?.value !== query) return false;

    const isVisible = (row: HTMLElement) => {
      let current: HTMLElement | null = row;
      while(current) {
        const style = getComputedStyle(current);
        if(style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        current = current.parentElement;
      }
      const rect = row.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const baselineRows = perf.globalSearchBaselineRows as WeakSet<Element>;
    for(const row of document.querySelectorAll<HTMLElement>('#search-container .chatlist-chat')) {
      const messageText = row.querySelector('.dialog-subtitle-parts')?.textContent || '';
      const matchesCurrentQuery = (window as any).__teagramIsCurrentGlobalSearchResult({
        query,
        inputValue: input.value,
        messageText,
        visible: isVisible(row),
        presentBeforeQuery: baselineRows.has(row)
      });
      if(!matchesCurrentQuery) continue;

      if(recordTimestamp) stages.matchingResultVisibleAtMs = performance.now();
      return true;
    }
    return false;
  }, {query, recordTimestamp}, {polling: 'raf', timeout: 90_000});
}

async function globalSearch(page: Page, requests: {value: number}, scale: Scale, traceEnabled = false, onMeasurementBoundary?: (boundary: MeasurementBoundary) => void, collectWalkDiagnostics = false) {
  await page.locator('#contacts-container .sidebar-close-button').click();
  await page.keyboard.press('Control+f');
  const input = page.locator('#column-left .item-main .sidebar-header .input-search-input');
  await expect(input).toBeVisible();
  const query = `needle ${scale === '1x' ? '5000' : '500000'}`;
  await beginScenario(page, requests, traceEnabled);
  await page.evaluate((query) => {
    const perf = (window as any).__teagramPerf;
    const input = document.querySelector<HTMLInputElement>('#column-left .item-main .sidebar-header .input-search-input');
    if(!input) throw new Error('global-search input is missing');

    const stages: Record<string, number> = perf.globalSearchStages = {};
    perf.globalSearchBaselineRows = new WeakSet(document.querySelectorAll('#search-container .chatlist-chat'));
    input.addEventListener('input', () => {
      if(input.value === query && !Number.isFinite(stages.queryEnteredAtMs)) {
        stages.queryEnteredAtMs = performance.now();
      }
    }, {capture: true});

    const apiManagerProxy = (window as any).apiManagerProxy;
    const invoke = apiManagerProxy?.invoke;
    if(typeof invoke !== 'function') throw new Error('global-search manager proxy is unavailable');
    apiManagerProxy.invoke = function(method: string, payload: any, ...args: any[]) {
      const result = invoke.call(this, method, payload, ...args);
      const options = payload?.args?.[0];
      if(method === 'manager' && payload?.name === 'appMessagesManager' && payload?.method === 'getHistory' &&
          options?.query === query && options?.inputFilter?._ === 'inputMessagesFilterEmpty' &&
          Number.isFinite(stages.queryEnteredAtMs) && !Number.isFinite(stages.debounceSettledAtMs)) {
        stages.debounceSettledAtMs = performance.now();
        apiManagerProxy.invoke = invoke;
      }
      return result;
    };
  }, query);
  await page.evaluate(() => (window as any).rootScope.managers.apiManager.resetPerformanceRpcTrace(true));
  await input.fill(query);
  await waitForGlobalSearchResult(page, query, true);

  const trace = await page.evaluate(async() => ({
    timeOrigin: performance.timeOrigin,
    trace: await (window as any).rootScope.managers.apiManager.getPerformanceRpcTrace()
  }));
  expect(trace.trace.enabled, 'targeted global-search RPC tracing was not enabled').toBe(true);
  const stages = await page.evaluate(() => ({...(window as any).__teagramPerf.globalSearchStages}));
  const matchingRpc = trace.trace.calls
  .filter((call: {method: string, startedAtEpochMs: number, durationMs: number | null, outcome: string}) => (
    call.method === 'messages.searchGlobal' && call.outcome === 'success' && typeof call.durationMs === 'number' && Number.isFinite(call.durationMs) &&
    call.startedAtEpochMs - trace.timeOrigin >= stages.debounceSettledAtMs &&
    call.startedAtEpochMs - trace.timeOrigin + call.durationMs <= stages.matchingResultVisibleAtMs
  ))
  .sort((left: {startedAtEpochMs: number}, right: {startedAtEpochMs: number}) => left.startedAtEpochMs - right.startedAtEpochMs)
  .at(-1);
  expect(matchingRpc, 'the current global-search query did not complete a matching search RPC').toBeDefined();
  if(!matchingRpc) throw new Error('the current global-search query did not complete a matching search RPC');
  const matchingSearchRpcReturnedAtMs = matchingRpc.startedAtEpochMs - trace.timeOrigin + matchingRpc.durationMs;
  const globalSearchStages = {...stages, matchingSearchRpcReturnedAtMs};
  const stageTimestamps = [
    globalSearchStages.queryEnteredAtMs,
    globalSearchStages.debounceSettledAtMs,
    globalSearchStages.matchingSearchRpcReturnedAtMs,
    globalSearchStages.matchingResultVisibleAtMs
  ];
  expect(stageTimestamps.every(Number.isFinite), 'global-search stage timestamps are incomplete').toBe(true);
  expect(globalSearchStages.queryEnteredAtMs).toBeLessThanOrEqual(globalSearchStages.debounceSettledAtMs);
  expect(globalSearchStages.debounceSettledAtMs).toBeLessThanOrEqual(globalSearchStages.matchingSearchRpcReturnedAtMs);
  expect(globalSearchStages.matchingSearchRpcReturnedAtMs).toBeLessThanOrEqual(globalSearchStages.matchingResultVisibleAtMs);

  const ms = globalSearchSampleMs(globalSearchStages);
  const snapshot = await snapshotMeasurementBoundary(page);
  const boundary = {...snapshot, startedAtMs: globalSearchStages.queryEnteredAtMs, ms};
  onMeasurementBoundary?.(boundary);
  const sample = await capture(page, requests, boundary, false, traceEnabled, traceEnabled || collectWalkDiagnostics, false, collectWalkDiagnostics);
  return {...sample, ms, globalSearchStages};
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
    const pageChats = document.querySelector<HTMLElement>('#page-chats');
    const bubbles = pageChats?.querySelector<HTMLElement>('.bubbles');
    if(!composer || !pageChats || !bubbles) throw new Error('send UI timing could not find the active composer and bubbles');

    const state: {
      startedAt: number | null,
      elapsedMs: number | null
    } = {startedAt: null, elapsedMs: null};
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
      if(!(event.target instanceof Element) || !event.target.closest('.input-message-input:not(.input-field-input-fake)[contenteditable="true"]')) return;
      if(event.key !== 'Enter' || event.shiftKey) return;
      if(event.isComposing) return;
      if(state.startedAt !== null) return;
      state.startedAt = performance.now();
    };
    const observer = new MutationObserver(recordBubbleInsertion);
    // Keep observing if chat setup replaces the bubbles element before the send completes.
    observer.observe(pageChats, {childList: true, subtree: true, characterData: true});
    document.addEventListener('keydown', onKeydown, true);
    (window as any).__teagramSendUiTiming = {
      state,
      cleanup: () => {
        observer.disconnect();
        document.removeEventListener('keydown', onKeydown, true);
        delete (window as any).__teagramSendUiTiming;
      }
    };
  }, text);
}

async function finishSendUiTiming(page: Page) {
  const result = await page.evaluate(() => {
    const timing = (window as any).__teagramSendUiTiming;
    if(!timing) return undefined;
    const elapsedMs = timing.state.elapsedMs;
    timing.cleanup();
    return elapsedMs;
  });
  if(!Number.isFinite(result)) throw new Error('in-page Enter-to-bubble timing did not observe the outgoing bubble');
  return result as number;
}

async function sendMessage(page: Page, requests: {value: number}, fixture: Fixture, traceRpc = false, onMeasurementBoundary?: (boundary: MeasurementBoundary) => void, collectWalkDiagnostics = false) {
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
    ...await capture(page, requests, boundary, false, traceRpc, traceRpc || collectWalkDiagnostics, false, collectWalkDiagnostics),
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
    const firstVisibleChatList = await waitForChatList(page);
    expect(firstVisibleChatList.source).toBe('snapshot');
    const sample = await capture(page, requests, await snapshotMeasurementBoundary(page, firstVisibleChatList), false, false, false, true);
    return {sample, injectedTask: injectStall ? await injectedLongTask(page) : undefined};
  } finally {
    await context.close();
  }
}

async function measureFirstStickerFrame(browser: Browser, run: VariantRun, fixture: Fixture, warmWorker: boolean) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });

  try {
    const page = await context.newPage();
    const requests = {value: 0};
    await installInstrumentation(page, requests, run.origin, false, false, false, !warmWorker);
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);

    if(warmWorker) {
      await page.evaluate(() => (window as any).lottieLoader.loadLottieWorkers());
      await waitForLottieWorker(page);
    }

    const workerReadyBeforeChat = await page.evaluate(() => (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).some((entry) => (
      entry.name.includes('tlottie.worker') && entry.responseEnd > 0
    )));

    await page.evaluate(({background, warmWorker}) => {
      const w = window as any;
      if(!warmWorker) {
        w.__performanceFirstStickerPaintTiming = {workerRequestAt: w.__teagramPerf.firstStickerWorkerRequestAt};
      }
      const loader = w.lottieLoader;
      const original = loader.loadAnimationWorker;
      let captured = false;
      loader.loadAnimationWorker = function(params: any) {
        const container = Array.isArray(params.container) ? params.container[0] : params.container;
        if(captured || !container?.closest('#page-chats .bubble.sticker-animated')) {
          return original.call(this, params);
        }

        captured = true;
        container.id = 'performance-first-sticker';
        container.style.setProperty('background-color', background, 'important');
        return Promise.resolve(original.call(this, params)).then((player: any) => {
          let recorded = false;
          const recordFirstFrame = () => {
            if(recorded) return;
            recorded = true;
            const firstFrameAt = performance.now();
            w.__performanceFirstStickerFrameAt = firstFrameAt;
            if(!warmWorker) {
              const timing = w.__performanceFirstStickerPaintTiming;
              timing.firstFrameAt = firstFrameAt;
              w.__teagramScheduleAfterInterveningPaint((nextPaintAt: number) => timing.nextPaintAt = nextPaintAt);
            }
          };
          if(player.hasRenderedFirstFrame) recordFirstFrame();
          else player.addEventListener('firstFrame', recordFirstFrame, {once: true});
          return player;
        });
      };
    }, {background: LOTTIE_FRAME_BG_CSS, warmWorker});

    const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
    await expect(row).toBeVisible({timeout: 60_000});
    await startMeasurementAtClick(row);
    await row.click();
    await waitForFirstVisibleBubble(page);
    await expect(page.locator('#page-chats .bubble.sticker-animated').first()).toBeVisible({timeout: 60_000});

    let onScreenAt: number | null = null;
    let firstFrameAt: number;
    let paintTiming: Awaited<ReturnType<typeof waitForFirstStickerPaint>> | undefined;
    if(warmWorker) {
      onScreenAt = await waitUntilOnScreen(page, page.locator('#performance-first-sticker'), 20_000);
      expect(onScreenAt, `${run.variant} first sticker frame never reached the screen`).not.toBeNull();
      firstFrameAt = await waitForFirstStickerFrame(page, 20_000);
    } else {
      paintTiming = await waitForFirstStickerPaint(page, 20_000);
      firstFrameAt = paintTiming.firstFrameAt;
    }
    const {clickAt} = await page.evaluate(() => ({clickAt: (window as any).__teagramPerf.clickAt as number}));
    expect(Number.isFinite(clickAt), `${run.variant} first sticker click timestamp was not recorded`).toBe(true);
    await page.evaluate(() => {
      const container = document.getElementById('performance-first-sticker');
      if(container) (window as any).lottieLoader.getAnimation(container)?.remove();
      container?.remove();
    });

    if(warmWorker) {
      return {
        workerReadyBeforeChat,
        clickToFirstFrameMs: firstFrameAt - clickAt,
        clickToVisibleFrameMs: onScreenAt! - clickAt
      };
    }

    expect(paintTiming && Number.isFinite(paintTiming.workerRequestAt), `${run.variant} first sticker worker request was not recorded`).toBe(true);
    return {
      workerReadyBeforeChat,
      pageTimestamps: {
        clickAt,
        workerRequestAt: paintTiming!.workerRequestAt,
        firstFrameAt,
        nextPaintAt: paintTiming!.nextPaintAt
      },
      clickToWorkerRequestMs: paintTiming!.workerRequestAt - clickAt,
      clickToFirstFrameMs: firstFrameAt - clickAt,
      clickToNextPaintMs: paintTiming!.nextPaintAt - clickAt,
      firstFrameToNextPaintMs: paintTiming!.nextPaintAt - firstFrameAt
    };
  } finally {
    await context.close();
  }
}

async function seedFirstStickerMessage(browser: Browser, run: VariantRun, fixture: Fixture): Promise<number> {
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
    const messageId = await page.evaluate(async({asset, partner}) => {
      let phase = 'load animation asset';
      try {
        const w = window as any;
        const response = await fetch(asset);
        if(!response.ok) throw new Error(`asset request returned ${response.status}`);
        const json = await response.arrayBuffer();
        const compressed = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
        const bytes = await new Response(compressed).arrayBuffer();
        const file = new File([bytes], 'AnimatedSticker.tgs', {type: 'application/x-tgsticker'});
        const managers = w.rootScope.managers;

        phase = 'upload sticker document';
        const uploaded = await managers.apiFileManager.upload({file, fileName: file.name});
        const randomId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

        phase = 'send sticker message';
        const sent: any = await managers.apiManager.invokeApi('messages.sendMedia', {
          peer: await managers.appPeersManager.getInputPeerById(partner),
          media: {
            _: 'inputMediaUploadedDocument',
            file: uploaded,
            mime_type: 'application/x-tgsticker',
            pFlags: {},
            attributes: [
              {_: 'documentAttributeSticker', pFlags: {}, alt: '🔑', stickerset: {_: 'inputStickerSetEmpty'}},
              {_: 'documentAttributeFilename', file_name: file.name}
            ]
          },
          message: '',
          random_id: randomId
        });

        const updates = sent?._ === 'updateShort' ? [sent.update] : sent?.updates || [];
        const newMessage = updates.find((update: any) => (
          update?._ === 'updateNewMessage' || update?._ === 'updateNewChannelMessage'
        ));
        const hasShortMessageId = [
          'updateShortSentMessage',
          'updateShortMessage',
          'updateShortChatMessage'
        ].includes(sent?._);
        const messageId = hasShortMessageId ? sent.id : newMessage?.message?.id;
        if(!Number.isSafeInteger(messageId)) throw new Error('sendMedia response did not include the new message id');
        return messageId as number;
      } catch(error) {
        const details = error instanceof Error ? error.message : JSON.stringify(error);
        throw new Error(`failed to ${phase}: ${details}`);
      }
    }, {asset: FIRST_STICKER_ASSET, partner: fixture.partner});
    return messageId;
  } finally {
    await context.close();
  }
}

async function deleteSeededStickerMessage(browser: Browser, run: VariantRun, fixture: Fixture, messageId: number) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });

  try {
    const page = await context.newPage();
    await installInstrumentation(page, {value: 0}, run.origin);
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
    await expect(row).toBeVisible({timeout: 60_000});
    await row.click();
    const sticker = page.locator(`#page-chats .bubble.sticker-animated[data-mid="${messageId}"]`);
    await expect(sticker).toBeVisible({timeout: 60_000});
    await expect(sticker.locator('.media-sticker-wrapper')).toHaveAttribute('data-doc-id', /.+/);
    await page.evaluate(async({peerId, messageId}) => {
      await (window as any).rootScope.managers.appMessagesManager.deleteMessages(peerId, [messageId], true);
    }, {peerId: fixture.partner, messageId});
    await expect(sticker).toHaveCount(0, {timeout: 60_000});
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
    const stickerBaseOrigin = process.env.PERF_STICKER_BASE_ORIGIN;
    expect(headOrigin, `${scale} head origin is missing`).toBeTruthy();
    if(report.requireBase) expect(baseOrigin, `${scale} base origin is missing`).toBeTruthy();
    if(report.requireBase && scale === '1x') expect(stickerBaseOrigin, 'pre-178 sticker base origin is missing').toBeTruthy();

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

  if(report.requireBase) {
    firstStickerPinnedRun = withOrigin(preparedVariants['1x'].base!, 'base', process.env.PERF_STICKER_BASE_ORIGIN!);
  }
});

test('measures first animated sticker frame after opening a chat', async({browser}) => {
  expect(reportPath).toBeTruthy();
  measurementsStarted = true;

  const fixture = fixtures['1x']!;
  const head = preparedVariants['1x'].head!;
  const messageId = await seedFirstStickerMessage(browser, head, fixture);
  let measurementFailed = false;

  try {
    const variants: Variant[] = report.requireBase ? ['base', 'head'] : ['head'];
    const stickerRuns: Partial<Record<StickerVariant, VariantRun>> = {head};
    if(report.requireBase) {
      stickerRuns.base = preparedVariants['1x'].base!;
      stickerRuns.pinned = firstStickerPinnedRun!;
    }
    const samples: Record<StickerVariant, Record<'cold' | 'warm', FirstStickerSample[]>> = {
      base: {cold: [], warm: []},
      head: {cold: [], warm: []},
      pinned: {cold: [], warm: []}
    };

    const coldRepeats = report.requireBase ? FIRST_STICKER_REPEATS : FIRST_STICKER_REPORT_REPEATS;
    for(let repeat = 0; repeat < coldRepeats; ++repeat) {
      const order = repeat % 2 === 0 ? variants : [...variants].reverse();
      for(const variant of order) {
        const coldSample = await test.step(`1x ${variant} cold first sticker repeat ${repeat + 1}`, async() => (
          measureFirstStickerFrame(browser, stickerRuns[variant]!, fixture, false)
        ));
        expect(coldSample.workerReadyBeforeChat, `${variant} worker was ready before the on-demand first sticker interaction`).toBe(false);
        samples[variant].cold.push(coldSample);
      }

      if(repeat < FIRST_STICKER_REPORT_REPEATS) {
        for(const variant of order) {
          const warmSample = await test.step(`1x ${variant} warm first sticker repeat ${repeat + 1}`, async() => (
            measureFirstStickerFrame(browser, stickerRuns[variant]!, fixture, true)
          ));
          expect(warmSample.workerReadyBeforeChat, `${variant} worker was not ready before the first sticker interaction`).toBe(true);
          samples[variant].warm.push(warmSample);
        }
      }
    }

    if(report.requireBase) {
      for(let repeat = 0; repeat < FIRST_STICKER_REPORT_REPEATS; ++repeat) {
        const pinnedSample = await test.step(`1x pinned pre-178 first sticker comparison repeat ${repeat + 1}`, async() => (
          measureFirstStickerFrame(browser, stickerRuns.pinned!, fixture, false)
        ));
        samples.pinned.cold.push(pinnedSample);
      }
    }

    const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
    const measuredVariants: StickerVariant[] = report.requireBase ? ['base', 'head', 'pinned'] : ['head'];
    const medians: Record<string, Record<string, {workerRequestMs?: number, workerFrameMs: number, paintedFrameMs?: number, firstFrameToPaintMs?: number, visibleFrameMs?: number}>> = {};
    for(const variant of measuredVariants) {
      medians[variant] = {};
      for(const temperature of ['cold', 'warm'] as const) {
        const values = samples[variant][temperature];
        if(!values.length) continue;
        expect(values).toHaveLength(variant === 'pinned' ? FIRST_STICKER_REPORT_REPEATS : temperature === 'cold' ? coldRepeats : FIRST_STICKER_REPORT_REPEATS);
        if(temperature === 'cold') {
          expect(values.every((sample) => (
            (variant === 'pinned' || sample.workerReadyBeforeChat === false) &&
            Number.isFinite(sample.clickToWorkerRequestMs) &&
            Number.isFinite(sample.clickToFirstFrameMs) &&
            Number.isFinite(sample.clickToNextPaintMs) &&
            Number.isFinite(sample.firstFrameToNextPaintMs)
          )), `${variant} cold first sticker sample is missing an in-page boundary`).toBe(true);
          medians[variant][temperature] = {
            workerRequestMs: median(values.map((sample) => sample.clickToWorkerRequestMs!)),
            workerFrameMs: median(values.map((sample) => sample.clickToFirstFrameMs)),
            paintedFrameMs: median(values.map((sample) => sample.clickToNextPaintMs!)),
            firstFrameToPaintMs: median(values.map((sample) => sample.firstFrameToNextPaintMs!))
          };
        } else {
          medians[variant][temperature] = {
            workerFrameMs: median(values.map((sample) => sample.clickToFirstFrameMs)),
            visibleFrameMs: median(values.map((sample) => sample.clickToVisibleFrameMs!))
          };
        }
      }
    }
    report.diagnostics.firstSticker = {
      scale: '1x',
      repeats: coldRepeats,
      boundary: 'cold: chat row click to the first painted frame after the player first frame; warm: chat row click to first rendered pixels',
      samples,
      medians
    };
    console.log(`[first-sticker] ${JSON.stringify({medians, samples})}`);
    measurementsComplete = true;
  } catch(error) {
    measurementFailed = true;
    throw error;
  } finally {
    try {
      await deleteSeededStickerMessage(browser, head, fixture, messageId);
    } catch(cleanupError) {
      console.error('Failed to clean up the seeded sticker message', cleanupError);
      if(!measurementFailed) throw cleanupError;
    }
  }
});

async function runVariant(browser: Browser, run: VariantRun, scale: Scale, fixture: Fixture) {
  const {variant, origin} = run;
  const measured = report.variants[variant][scale];
  const collectWalkDiagnostics = scale === '100x';
  const reconcileTargets: CachedDialogReconcileTarget[] = [];
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
    const firstVisibleChatList = await waitForChatList(page);
    expect(firstVisibleChatList.source).toBe('snapshot');
    const coldChatList = await test.step('cold chat list', async() => capture(
      page,
      requests,
      await snapshotMeasurementBoundary(page, firstVisibleChatList),
      false,
      false,
      collectWalkDiagnostics,
      true,
      collectWalkDiagnostics
    ));
    expect(coldChatList.ms).toBe(coldChatList.firstVisibleChatListMs);
    expect(coldChatList.liveBoundaryMs).toBeGreaterThanOrEqual(coldChatList.ms);
    measured.coldChatList.push(coldChatList);
    if(collectWalkDiagnostics) await addCachedDialogReconcileTarget(page, reconcileTargets, coldChatList, 'coldChatList');
    const warmChatList = await test.step('warm chat list', () => reloadChatList(page, requests, collectWalkDiagnostics));
    expect(warmChatList.ms).toBe(warmChatList.firstVisibleChatListMs);
    expect(warmChatList.liveBoundaryMs).toBeGreaterThanOrEqual(warmChatList.ms);
    measured.warmChatList.push(warmChatList);
    if(collectWalkDiagnostics) await addCachedDialogReconcileTarget(page, reconcileTargets, warmChatList, 'warmChatList');

    const chatOpen = await test.step('open scale fixture chat', () => openPartnerChat(page, requests, fixture, scale === '100x', collectWalkDiagnostics, scale === '100x'));
    measured.chatOpen.push(chatOpen);
    if(collectWalkDiagnostics) await addCachedDialogReconcileTarget(page, reconcileTargets, chatOpen, 'chatOpen');
    const scroll = await test.step('scroll back 2,000 messages', () => scrollBackTwoThousand(
      page,
      requests,
      true,
      scale === '100x' ? {
        pauseLongAnimationFrames: true,
        collectWalkDiagnostics
      } : undefined
    ));
    if(!scroll) throw new Error(`${variant} scroll-back did not reach 2,000 messages`);
    measured.scrollBack2k.push(scroll);
    if(collectWalkDiagnostics) await addCachedDialogReconcileTarget(page, reconcileTargets, scroll, 'scrollBack2k');
    const jump = await test.step('jump to fixture date', () => jumpToFixtureDate(page, requests, fixture, false, undefined, collectWalkDiagnostics), {timeout: 120_000});
    if(!jump) throw new Error(`${variant} date-jump did not reach the fixture date`);
    measured.dateJump.push(jump);
    if(collectWalkDiagnostics) await addCachedDialogReconcileTarget(page, reconcileTargets, jump, 'dateJump');
    await finalizeServerRpcTrace(page, chatOpen);

    // Reset both variants to the same signed-in chat-list state before contacts measurements.
    await resetToChatList(page, origin);
    const contactsList = await test.step('open contacts', () => openContacts(page, requests, variant, false, undefined, collectWalkDiagnostics));
    measured.contactsList.push(contactsList);
    if(collectWalkDiagnostics) await addCachedDialogReconcileTarget(page, reconcileTargets, contactsList, 'contactsList');
    const contactSearch = await test.step('search contacts', () => searchContacts(page, requests, scale, false, undefined, collectWalkDiagnostics));
    measured.contactSearch.push(contactSearch);
    if(collectWalkDiagnostics) await addCachedDialogReconcileTarget(page, reconcileTargets, contactSearch, 'contactSearch');
    const globalSearchSample = await test.step('global message search', () => globalSearch(page, requests, scale, false, undefined, collectWalkDiagnostics));
    measured.globalSearch.push(globalSearchSample);
    if(collectWalkDiagnostics) await addCachedDialogReconcileTarget(page, reconcileTargets, globalSearchSample, 'globalSearch');
    const sendMessageSample = await test.step('send a message', () => sendMessage(page, requests, fixture, false, undefined, collectWalkDiagnostics));
    measured.sendMessage.push(sendMessageSample);
    if(collectWalkDiagnostics) {
      await addCachedDialogReconcileTarget(page, reconcileTargets, sendMessageSample, 'sendMessage');
      await finalizeCachedDialogReconcileSummaries(page, reconcileTargets);
    }
  } finally {
    await context.close();
  }
}

async function traceDateJump(browser: Browser, run: VariantRun, fixture: Fixture) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });
  try {
    const page = await context.newPage();
    const requests = {value: 0};
    const reconcileTargets: CachedDialogReconcileTarget[] = [];
    await installInstrumentation(page, requests, run.origin, false, true);
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);

    await beginScenario(page, requests, true);
    await page.reload({waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
    await expect(row).toBeVisible({timeout: 60_000});
    await beginScenario(page, requests, true);
    await startMeasurementAtClick(row);
    await row.click();
    await waitForFirstVisibleBubble(page);

    let dateJumpBoundary: MeasurementBoundary | undefined;
    const jumped = await jumpToFixtureDate(page, requests, fixture, true, (boundary) => dateJumpBoundary = boundary);
    if(!jumped || !dateJumpBoundary) throw new Error('date-jump profile did not record its measurement boundary');
    await addCachedDialogReconcileTarget(page, reconcileTargets, jumped, 'dateJump');
    await finalizeCachedDialogReconcileSummaries(page, reconcileTargets);
    return jumped;
  } finally {
    await context.close();
  }
}

async function traceTargetScenarios(browser: Browser, runs: Partial<Record<Variant, VariantRun>>, fixture: Fixture) {
  const variants = (Object.keys(runs) as Variant[]).sort((left, right) => left === 'base' ? -1 : right === 'base' ? 1 : 0);
  const traceSamplesByVariant = Object.fromEntries(variants.map((variant) => [
    variant,
    Object.fromEntries(scenarios.map((scenario) => [scenario, [] as Metric[]])) as Record<string, Metric[]>
  ])) as Partial<Record<Variant, Record<string, Metric[]>>>;

  for(let repeat = 0; repeat < TRACE_DIAGNOSTIC_REPEATS; ++repeat) {
    const order = repeat % 2 ? [...variants].reverse() : variants;
    for(const variant of order) {
    const run = runs[variant]!;
    const traceSamples = traceSamplesByVariant[variant]!;
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
      const coldFirstVisibleChatList = await waitForChatList(page);
      expect(coldFirstVisibleChatList.source).toBe('snapshot');
      const coldBoundary = await snapshotMeasurementBoundary(page, coldFirstVisibleChatList);
      const coldCapture = await capture(page, requests, coldBoundary, false, true, true, true);
      const coldSample = {...coldCapture, ...(coldProfile ? {cpu: await finishCpuProfile(coldProfile)} : {})};
      traceSamples.coldChatList.push(coldSample);
      await addCachedDialogReconcileTarget(page, reconcileTargets, coldSample, 'coldChatList');

      if(repeat < TRACE_DIAGNOSTIC_REPEATS) {
        await beginScenario(page, requests, true);
        const warmProfile = repeat === 0 ? await startCpuProfile(page) : undefined;
        await page.reload({waitUntil: 'domcontentloaded'});
        const warmFirstVisibleChatList = await waitForChatList(page);
        expect(warmFirstVisibleChatList.source).toBe('snapshot');
        const warmBoundary = await snapshotMeasurementBoundary(page, warmFirstVisibleChatList);
        const warmCapture = await capture(page, requests, warmBoundary, false, true, true, true);
        const warmSample = {...warmCapture, ...(warmProfile ? {cpu: await finishCpuProfile(warmProfile)} : {})};
        traceSamples.warmChatList.push(warmSample);
        await addCachedDialogReconcileTarget(page, reconcileTargets, warmSample, 'warmChatList');

        const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
        await expect(row).toBeVisible({timeout: 60_000});
        await prepareChatOpenStartState(page, fixture);
        await beginScenario(page, requests, true);
        await installPeerChangeTracing(page);
        const chatProfile = await startCpuProfile(page);
        const serverTraceOffset = serverRpcTraceOffset();
        await startMeasurementAtClick(row);
        await row.click();
        const chatOpenBoundary = await waitForFirstVisibleBubble(page);
        const chatCpu = await finishCpuProfile(chatProfile);
        const chatOpenCapture = await capture(page, requests, chatOpenBoundary, false, true, true, false, false, true, true);
        const chatOpenSample = {
          ...chatOpenCapture,
          cpu: chatCpu,
          peerChangePhases: summarizePerformancePhases(await page.evaluate(() => {
            const perf = (window as any).__teagramPerf;
            const offset = perf.clickAt - perf.peerChangeBase;
            return (perf.peerChangePhases || []).map((phase: {startMs: number}) => ({...phase, startMs: Number((phase.startMs - offset).toFixed(1))}));
          }))
        };
        serverRpcTraceOffsetsBySample.set(chatOpenSample, serverTraceOffset);
        await finalizeServerRpcTrace(page, chatOpenSample);
        traceSamples.chatOpen.push(chatOpenSample);
        await addCachedDialogReconcileTarget(page, reconcileTargets, chatOpenSample, 'chatOpen');

        // Every diagnostic repeat scrolls back, so each one's long tasks carry their own CPU stacks and spans.
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

        await waitForCachedDialogReconcileBeforeNavigation(page);
        await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
        await waitForChatList(page);

        let contactsBoundary: MeasurementBoundary | undefined;
        const contacts = await test.step(`profile 100x contacts list (repeat ${repeat + 1})`, () => openContacts(
          page,
          requests,
          run.variant,
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

    if(repeat < TRACE_DIAGNOSTIC_REPEATS) {
      const jumped = await test.step(`profile 100x date jump (repeat ${repeat + 1})`, () => traceDateJump(browser, run, fixture));
      traceSamples.dateJump.push(jumped);
    }
    }
  }

  for(const variant of variants) {
    const traceSamples = traceSamplesByVariant[variant]!;
    for(const scenario of scenarios) {
      const requireWalk = scenario === 'warmChatList' || scenario === 'chatOpen' || scenario === 'scrollBack2k' || scenario === 'dateJump';
      validateCachedDialogReconcileDiagnostics(traceSamples[scenario], scenario, TRACE_DIAGNOSTIC_REPEATS, requireWalk);
      traceSamples[scenario].forEach((sample) => {
        sample.walkLongTasksOver50Ms = findLongTasksOverlappingWalkMirrors(sample.longTaskTrace, sample.reconcileMirrorTasks).length;
      });
    }
  }

  const rpcComparison = Object.fromEntries(variants.map((variant) => [variant, {
    chatOpen: traceSamplesByVariant[variant]!.chatOpen,
    sendMessage: traceSamplesByVariant[variant]!.sendMessage
  }]));
  return {...traceSamplesByVariant.head!, rpcComparison};
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

  const traceOrigin = process.env.PERF_TRACE_HEAD_ORIGIN_100X;
  expect(traceOrigin, '100x traced head origin is missing').toBeTruthy();
  const traceRun = withOrigin(preparedVariants['100x'].head!, 'head', traceOrigin!);
  const traceRuns: Partial<Record<Variant, VariantRun>> = {head: traceRun};
  if(report.requireBase) {
    const baseTraceOrigin = process.env.PERF_TRACE_BASE_ORIGIN_100X;
    expect(baseTraceOrigin, '100x traced base origin is missing').toBeTruthy();
    traceRuns.base = withOrigin(preparedVariants['100x'].base!, 'base', baseTraceOrigin!);
  }
  const traceDiagnostics = await test.step('trace paired 100x client CPU and RPC waits', () => traceTargetScenarios(browser, traceRuns, fixtures['100x']!));
  const walkComparison = buildWalkComparison(
    Object.fromEntries((Object.keys(traceRuns) as Variant[]).map((variant) => [variant, report.variants[variant]['100x']])),
    PERFORMANCE_REPEATS
  );
  for(const variant of Object.keys(traceRuns) as Variant[]) {
    for(const scenario of scenarios) {
      const samples = report.variants[variant]['100x'][scenario] as Metric[];
      validateCachedDialogReconcileDiagnostics(samples, scenario, PERFORMANCE_REPEATS);
      samples.forEach((sample) => {
        delete sample.cachedDialogReconcile;
        delete sample.longTaskTrace;
        if(variant === 'head' && scenario === 'scrollBack2k') {
          expect(sample).not.toHaveProperty('longTaskTraceStatus');
        }
        delete sample.reconcileMirrorTasks;
      });
    }
  }
  report.diagnostics['100x'] = {...traceDiagnostics, walkComparison};
  measurementsComplete = true;
});

test('detects repeated injected 100 ms main-thread stalls as blocking regressions', async({browser}) => {
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
  const coldLoadFindings = coldLoadEvaluation.blockingFailures.filter((finding) => finding.startsWith('100x coldChatList: '));
  const blockingTimes = (samples: Metric[]) => samples.map((sample) => sample.blockingTimeMs);
  expect(
    coldLoadFindings.some((finding) => finding.includes('long-task blocking time')),
    `100 ms control was not detected as a blocking regression: control blocking ${JSON.stringify(blockingTimes(negativeSamples))} ms vs same-phase head ${JSON.stringify(blockingTimes(controlSamples))} ms`
  ).toBe(true);
});

test('tracks an outgoing bubble after the bubbles container is replaced', async({page}) => {
  const text = 'replacement-send';
  await page.setContent('<main id="page-chats"><div class="bubbles"></div><div class="input-message-input" contenteditable="true"></div></main>');
  await installSendUiTiming(page, text);
  await page.locator('.input-message-input').press('Enter');
  await page.locator('#page-chats .bubbles').evaluate((bubbles, sendText) => {
    const replacement = document.createElement('div');
    replacement.className = 'bubbles';
    const bubble = document.createElement('div');
    bubble.className = 'bubble is-out';
    bubble.textContent = sendText;
    replacement.append(bubble);
    bubbles.replaceWith(replacement);
  }, text);

  await expect(page.locator('#page-chats .bubble.is-out')).toHaveText(text);
  expect(await finishSendUiTiming(page)).toBeGreaterThanOrEqual(0);
});

test('tracks an outgoing bubble when the composer is replaced before Enter', async({page}) => {
  const text = 'replacement-composer-send';
  await page.setContent('<main id="page-chats"><div class="bubbles"></div><div class="input-message-input" contenteditable="true"></div></main>');
  await installSendUiTiming(page, text);
  await page.locator('.input-message-input').evaluate((composer) => {
    const replacement = document.createElement('div');
    replacement.className = 'input-message-input';
    replacement.contentEditable = 'true';
    composer.replaceWith(replacement);
  });
  await page.locator('.input-message-input').press('Enter');
  await page.locator('#page-chats .bubbles').evaluate((bubbles, sendText) => {
    const bubble = document.createElement('div');
    bubble.className = 'bubble is-out';
    bubble.textContent = sendText;
    bubbles.append(bubble);
  }, text);

  await expect(page.locator('#page-chats .bubble.is-out')).toHaveText(text);
  expect(await finishSendUiTiming(page)).toBeGreaterThanOrEqual(0);
});

test('fails closed when a send is suppressed and no outgoing bubble appears', async({page}) => {
  await page.setContent('<main id="page-chats"><div class="bubbles"></div><div class="input-message-input" contenteditable="true"></div></main>');
  await installSendUiTiming(page, 'suppressed-send');
  await page.locator('.input-message-input').press('Enter');

  await expect(finishSendUiTiming(page)).rejects.toThrow('in-page Enter-to-bubble timing did not observe the outgoing bubble');
});
