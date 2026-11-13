import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {PERFORMANCE_MEASUREMENT_VERSION, PERFORMANCE_REPEATS, SCENARIOS} from './policy.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/performance.yml', import.meta.url), 'utf8');
const playwrightConfig = readFileSync(new URL('../../playwright.performance.config.ts', import.meta.url), 'utf8');
const performanceScale = readFileSync(new URL('../../e2e/performanceScale.spec.ts', import.meta.url), 'utf8');
const performanceTrace = readFileSync(new URL('../../src/lib/appManagers/performanceTrace.ts', import.meta.url), 'utf8');
const mainMessagePort = readFileSync(new URL('../../src/lib/mainWorker/mainMessagePort.ts', import.meta.url), 'utf8');
const mainWorker = readFileSync(new URL('../../src/lib/mainWorker/index.worker.ts', import.meta.url), 'utf8');
const performanceClientBuild = readFileSync(new URL('./build-client-bundles.sh', import.meta.url), 'utf8');
const workerReplay = readFileSync(new URL('../../e2e/workerMessageReplay.spec.ts', import.meta.url), 'utf8');
const chatPageSnapshotView = readFileSync(new URL('../../src/lib/chatPageSnapshotView.ts', import.meta.url), 'utf8');
const stickerBaseCommit = readFileSync(new URL('../../.github/perf-sticker-base-commit', import.meta.url), 'utf8').trim();

function firstStickerMeasurements() {
  const coldSampleSet = (workerRequestMs, firstFrameMs, nextPaintMs, count) => Array.from({length: count}, () => ({
    workerReadyBeforeChat: false,
    clickToWorkerRequestMs: workerRequestMs,
    clickToFirstFrameMs: firstFrameMs,
    clickToNextPaintMs: nextPaintMs,
    firstFrameToNextPaintMs: nextPaintMs - firstFrameMs,
    pageTimestamps: {clickAt: 0, workerRequestAt: workerRequestMs, firstFrameAt: firstFrameMs, nextPaintAt: nextPaintMs},
    clickToVisibleFrameMs: 900
  }));
  const warmSampleSet = (visibleFrameMs, count) => Array.from({length: count}, () => ({clickToFirstFrameMs: visibleFrameMs / 2, clickToVisibleFrameMs: visibleFrameMs}));
  const samples = {
    base: {cold: coldSampleSet(10, 180, 200, PERFORMANCE_REPEATS), warm: warmSampleSet(150, 3)},
    head: {cold: coldSampleSet(12, 230, 250, PERFORMANCE_REPEATS), warm: warmSampleSet(190, 3)},
    pinned: {cold: coldSampleSet(11, 160, 180, 3), warm: []}
  };
  return {
    repeats: PERFORMANCE_REPEATS,
    samples,
    medians: {
      base: {
        cold: {workerRequestMs: 10, workerFrameMs: 180, paintedFrameMs: 200, firstFrameToPaintMs: 20},
        warm: {workerFrameMs: 75, visibleFrameMs: 150}
      },
      head: {
        cold: {workerRequestMs: 12, workerFrameMs: 230, paintedFrameMs: 250, firstFrameToPaintMs: 20},
        warm: {workerFrameMs: 95, visibleFrameMs: 190}
      },
      pinned: {
        cold: {workerRequestMs: 11, workerFrameMs: 160, paintedFrameMs: 180, firstFrameToPaintMs: 20}
      }
    }
  };
}

function workerRecorderMeasurements() {
  return {
    peers: {offMs: 10, onMs: 11, pairedDeltaMs: 1, pairedDeltaSamples: Array(9).fill(1), iterations: 50},
    dialogs: {offMs: 20, onMs: 21, pairedDeltaMs: 1, pairedDeltaSamples: Array(9).fill(1), iterations: 50}
  };
}

function runSummaryWithArtifacts({
  firstSticker = firstStickerMeasurements(),
  recorderReplay = workerRecorderMeasurements(),
  includeChatOpenServerRecords = true,
  chatOpenServerHistoryRecordCount = 1,
  chatOpenClientHistoryCallCount = 1,
  chatOpenServerClientHistoryCallCount = chatOpenClientHistoryCallCount,
  includeChatOpenClientRpcData = true,
  chatOpenRpcWallMs = 60,
  requireBase = true,
  eventName = 'pull_request',
  mutateReport
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tweb-performance-summary-validation-'));
  const reportPath = join(directory, 'report.json');
  const recorderReplayPath = join(directory, 'recorder-replay.json');
  const historyDirectory = join(directory, 'history');
  const serverRpcRecords = includeChatOpenServerRecords ? Array.from({length: chatOpenServerHistoryRecordCount}, (_, index) => ({
    method: 'messages.getHistory',
    duration_us: 40_123,
    result: 'success',
    end_unix_ms: 1_762_800_000_063 + index
  })) : undefined;
  const serverRpcClientCalls = Array.from({length: chatOpenServerClientHistoryCallCount}, (_, index) => ({
    callId: index + 1,
    method: 'messages.getHistory',
    startedAtEpochMs: 1_762_800_000_000,
    durationMs: 60,
    outcome: 'success'
  }));
  const makeSample = (key) => ({
    ms: key === 'globalSearch' ? 400 : 100,
    ...(key === 'sendMessage' ? {appSendUiMs: 80} : {}),
    ...(key === 'globalSearch' ? {
      globalSearchStages: {
        queryEnteredAtMs: 100,
        debounceSettledAtMs: 400,
        matchingSearchRpcReturnedAtMs: 480,
        matchingResultVisibleAtMs: 500
      }
    } : {}),
    requests: 12,
    rpcCallCount: 2,
    domNodes: 300,
    bundleBytes: 100_000,
    longTasksOver50Ms: 0,
    blockingTimeMs: 0,
    maxLongTaskDurationMs: 0,
    ...(key === 'chatOpen' && serverRpcRecords ? {serverRpcRecords} : {}),
    ...(key === 'chatOpen' ? {
      serverRpcGateWindow: {startEpochMs: 1_762_800_000_000, endEpochMs: 1_762_800_000_100},
      rpcWallMs: includeChatOpenClientRpcData ? chatOpenRpcWallMs : null,
      nonRpcElapsedMs: includeChatOpenClientRpcData ? 100 - chatOpenRpcWallMs : null,
      serverRpcClientCalls,
      rpcCalls: includeChatOpenClientRpcData ? Array.from({length: chatOpenClientHistoryCallCount}, () => ({
        method: 'messages.getHistory',
        startedAtMs: 0,
        durationMs: chatOpenRpcWallMs,
        outcome: 'success'
      })) : []
    } : {}),
    ...(key === 'scrollBack2k' ? {
      frameIntervals: 100,
      droppedFrames: 3,
      droppedFramePercent: 3 / 103 * 100,
      rafDropped: 3
    } : {})
  });
  const variantsFor = () => Object.fromEntries(['1x', '100x'].map((scale) => [scale, Object.fromEntries(SCENARIOS.map(({key}) => [
    key,
    Array.from({length: PERFORMANCE_REPEATS}, () => makeSample(key))
  ]))]));
  const head = variantsFor();
  const base = variantsFor();
  const walkSamples = () => Array.from({length: PERFORMANCE_REPEATS}, () => ({walkLongTasksOver50Ms: 0}));
  const report = {
    measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
    fixtureVersion: 'fixture-v1',
    serverCommit: 'server-v1',
    fixtureServerCommit: 'fixture-server-v1',
    requireBase,
    diagnostics: {
      firstSticker,
      '100x': {
        walkComparison: {
          base: Object.fromEntries(SCENARIOS.map(({key}) => [key, walkSamples()])),
          head: Object.fromEntries(SCENARIOS.map(({key}) => [key, walkSamples()]))
        },
        sendMessage: [{
          ms: 123,
          appSendUiMs: 101,
          requests: 0,
          domNodes: 1_000,
          domNodeCounts: {bubbleGroups: 12},
          longTasksOver50Ms: 0,
          walkLongTasksOver50Ms: 0,
          blockingTimeMs: 0,
          rpcCallCount: 1,
          rpcWallMs: 81,
          nonRpcElapsedMs: 42,
          rpcCalls: [{method: 'messages.sendMessage', durationMs: 81, outcome: 'success'}],
          cpu: {topFrames: [{functionName: 'sendMessage', script: '/input.ts', selfMs: 22}]}
        }],
        rpcComparison: Object.fromEntries(['base', 'head'].map((variant) => [variant, {
          chatOpen: [{
            ms: 377,
            serverRpcGateWindow: {startEpochMs: 1_762_800_000_000, endEpochMs: 1_762_800_000_377},
            rpcCallCount: chatOpenClientHistoryCallCount,
            rpcWallMs: chatOpenClientHistoryCallCount ? 377 : 0,
            nonRpcElapsedMs: chatOpenClientHistoryCallCount ? 0 : 377,
            rpcCalls: includeChatOpenClientRpcData ? Array.from({length: chatOpenClientHistoryCallCount}, () => ({method: 'messages.getHistory', startedAtMs: 0, durationMs: 377, outcome: 'success'})) : [],
            serverRpcClientCalls,
            ...(serverRpcRecords ? {serverRpcRecords} : {})
          }]
        }]))
      }
    },
    variants: {base, head}
  };
  mutateReport?.(report);
  writeFileSync(reportPath, JSON.stringify(report));
  if(recorderReplay !== null) writeFileSync(recorderReplayPath, JSON.stringify(recorderReplay));

  try {
    return spawnSync(process.execPath, [new URL('./write-summary.mjs', import.meta.url).pathname], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PERF_REPORT_PATH: reportPath,
        PERF_RECORDER_REPLAY_PATH: recorderReplayPath,
        PERF_HISTORY_DIRECTORY: historyDirectory,
        PERF_BROWSER_OUTCOME: 'success',
        PERF_RECORDER_REPLAY_OUTCOME: 'success',
        GITHUB_EVENT_NAME: eventName,
        GITHUB_REF: eventName === 'push' ? 'refs/heads/master' : '',
        GITHUB_STEP_SUMMARY: ''
      }
    });
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

test('timing bundles enable targeted search and history probes while keeping full profiles separate', () => {
  assert.match(performanceClientBuild, /^VITE_PERF_RECONCILE_TRACE=1 VITE_PERF_SEARCH_TRACE=1 VITE_PERF_HISTORY_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-head-dist"\s*$/m);
  assert.match(performanceClientBuild, /^\s+\(cd "\$base_directory" && VITE_PERF_RECONCILE_TRACE=1 VITE_PERF_SEARCH_TRACE=1 VITE_PERF_HISTORY_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-base-dist"\)\s*$/m);
  assert.match(performanceClientBuild, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-trace-dist"/);
  assert.doesNotMatch(performanceClientBuild, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-(?:head|base)-dist"/);
});

test('base search tracing preserves application RPC differences from the head bundle', async() => {
  assert.doesNotMatch(performanceClientBuild, /git -C "\$base_directory" checkout .*src\/lib\/appManagers\/apiManager\.ts/);
  assert.match(performanceClientBuild, /node scripts\/performance\/inject-search-rpc-tracer\.mjs "\$base_directory\/src\/lib\/appManagers\/apiManager\.ts"/);
  assert.match(performanceClientBuild, /VITE_PERF_RECONCILE_TRACE=1 VITE_PERF_SEARCH_TRACE=1 VITE_PERF_HISTORY_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-head-dist"/);
  assert.match(performanceClientBuild, /\(cd "\$base_directory" && VITE_PERF_RECONCILE_TRACE=1 VITE_PERF_SEARCH_TRACE=1 VITE_PERF_HISTORY_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-base-dist"\)/);

  const baseApiManager = [
    'export class ApiManager {',
    '  private performanceRpcTrace?: PerformanceRpcTrace;',
    '  constructor() {',
    "    if(import.meta.env.VITE_PERF_TRACE === '1') {",
    '      this.performanceRpcTrace = new PerformanceRpcTrace(true);',
    '    }',
    '  }',
    '  public resetPerformanceRpcTrace(recordSpans = true) {',
    "    if(import.meta.env.VITE_PERF_TRACE === '1') this.performanceRpcTrace!.reset(recordSpans);",
    '  }',
    '  public invokeApi(method, params = {}, options = {}) {',
    '    const methodName = String(method);',
    "    if(import.meta.env.VITE_PERF_TRACE === '1') this.performanceRpcTrace?.recordCall(methodName);",
    '    if(!getAuthMethod(methodName, params)) {',
    '      return this.invokeApiInternal(method, params, options);',
    '    }',
    '    const redactor = this.authLogRedactor ??= new AuthLogRedactor(this.log);',
    '    redactor.begin();',
    '    try {',
    '      const request = this.invokeApiInternal(method, params, options);',
    '      request.then(() => redactor.end(), () => redactor.end());',
    '      return request;',
    '    } catch(error) {',
    '      redactor.end();',
    '      throw error;',
    '    }',
    '  }',
    '  private invokeApiInternal(method, params, options) {',
    "    return {implementation: 'base RPC handling', method, params, options};",
    '  }',
    '}'
  ].join('\n');
  const headApiManager = baseApiManager.replace('base RPC handling', 'head RPC handling');
  const {injectSearchRpcTracer} = await import('./inject-search-rpc-tracer.mjs');
  const instrumentedBase = injectSearchRpcTracer(baseApiManager);
  const instrumentedHead = injectSearchRpcTracer(headApiManager);
  const searchAwareBase = baseApiManager
    .replace(
      "    if(import.meta.env.VITE_PERF_TRACE === '1') {\n      this.performanceRpcTrace = new PerformanceRpcTrace(true);\n    }",
      "    if(import.meta.env.VITE_PERF_TRACE === '1' || import.meta.env.VITE_PERF_SEARCH_TRACE === '1') {\n      this.performanceRpcTrace = new PerformanceRpcTrace(true);\n    }"
    )
    .replace(
      "    if(import.meta.env.VITE_PERF_TRACE === '1') this.performanceRpcTrace!.reset(recordSpans);",
      "    if(import.meta.env.VITE_PERF_TRACE === '1' || import.meta.env.VITE_PERF_SEARCH_TRACE === '1') {\n      this.performanceRpcTrace!.reset(recordSpans);\n    }"
    )
    .replace(
      "    if(import.meta.env.VITE_PERF_TRACE === '1') this.performanceRpcTrace?.recordCall(methodName);",
      "    if(import.meta.env.VITE_PERF_TRACE === '1') this.performanceRpcTrace?.recordCall(methodName);\n    const traceSearch = import.meta.env.VITE_PERF_SEARCH_TRACE === '1' && methodName === 'messages.searchGlobal';"
    )
    .replace(
      '      return this.invokeApiInternal(method, params, options);',
      '      const request = this.invokeApiInternal(method, params, options);\n      return traceSearch ? this.performanceRpcTrace?.trackWait(methodName, request) ?? request : request;'
    );
  const instrumentedSearchAwareBase = injectSearchRpcTracer(searchAwareBase);

  assert.match(instrumentedBase, /implementation: 'base RPC handling'/);
  assert.doesNotMatch(instrumentedBase, /head RPC handling/);
  assert.match(instrumentedHead, /implementation: 'head RPC handling'/);
  assert.doesNotMatch(instrumentedHead, /base RPC handling/);
  assert.match(instrumentedBase, /VITE_PERF_SEARCH_TRACE/);
  assert.match(instrumentedHead, /VITE_PERF_SEARCH_TRACE/);
  assert.match(instrumentedBase, /VITE_PERF_HISTORY_TRACE/);
  assert.match(instrumentedBase, /messages\.getHistory/);
  assert.match(instrumentedBase, /traceHistory \? this\.performanceRpcTrace\?\.trackWait/);
  assert.match(instrumentedHead, /VITE_PERF_HISTORY_TRACE/);
  assert.match(instrumentedSearchAwareBase, /VITE_PERF_HISTORY_TRACE/);
  assert.match(instrumentedSearchAwareBase, /const traceSearch =/);
  assert.match(instrumentedSearchAwareBase, /return traceSearch \|\| traceHistory \?/);
});

test('search RPC tracer injection accepts the current ApiManager unchanged and is repeatable', async() => {
  const apiManager = readFileSync(new URL('../../src/lib/appManagers/apiManager.ts', import.meta.url), 'utf8');
  const {injectSearchRpcTracer} = await import('./inject-search-rpc-tracer.mjs');

  const firstInjection = injectSearchRpcTracer(apiManager);
  const secondInjection = injectSearchRpcTracer(firstInjection);

  assert.equal(firstInjection, apiManager);
  assert.equal(secondInjection, apiManager);
});

test('head worker registers the mirror queue barrier only in performance builds', () => {
  assert.match(mainWorker, /\.\.\.\(import\.meta\.env\.VITE_PERF_HISTORY_TRACE === '1' \|\| import\.meta\.env\.VITE_PERF_TRACE === '1' \? \{\s*mirrorQueueBarrier:/);
  assert.match(performanceClientBuild, /VITE_PERF_RECONCILE_TRACE=1 VITE_PERF_SEARCH_TRACE=1 VITE_PERF_HISTORY_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-head-dist"/);
  assert.match(performanceClientBuild, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-trace-dist"/);
});

test('base worker bundle injection adds an idempotent mirror queue acknowledgement', async() => {
  const {injectMirrorQueueBarrier} = await import('./inject-mirror-queue-barrier.mjs');
  const baseMainMessagePort = [
    '  getLogs: (payload: void) => LogEntry[],',
    '  setLogBufferEnabled: (enabled: boolean) => void,',
    '  getMemoryStats: (payload: void) => Promise<ThreadMemoryStats>'
  ].join('\n');
  const baseIndexWorker = [
    '  getLogs: () => getLogEntries(),',
    '',
    '  getMemoryStats: async() => {'
  ].join('\n');

  const firstInjection = injectMirrorQueueBarrier(baseMainMessagePort, baseIndexWorker);
  const secondInjection = injectMirrorQueueBarrier(firstInjection.mainMessagePort, firstInjection.indexWorker);

  assert.match(firstInjection.mainMessagePort, /mirrorQueueBarrier: \(payload: void\) => void/);
  assert.match(firstInjection.indexWorker, /mirrorQueueBarrier: \(\) => \{[\s\S]*?earlier worker-to-window mirror messages/);
  assert.deepEqual(secondInjection, firstInjection);
  assert.throws(
    () => injectMirrorQueueBarrier(`${baseMainMessagePort}\n${baseMainMessagePort}`, baseIndexWorker),
    /main worker message-port anchor is ambiguous/
  );
  assert.throws(
    () => injectMirrorQueueBarrier(firstInjection.mainMessagePort, baseIndexWorker),
    /base worker sources are partially instrumented/
  );
});

test('search RPC tracer injection still rejects duplicate anchors in an instrumented source', async() => {
  const apiManager = readFileSync(new URL('../../src/lib/appManagers/apiManager.ts', import.meta.url), 'utf8');
  const {injectSearchRpcTracer} = await import('./inject-search-rpc-tracer.mjs');
  const duplicateInitialization = '    if(import.meta.env.VITE_PERF_TRACE === \'1\') {\n      this.performanceRpcTrace = new PerformanceRpcTrace(true);\n    }';

  assert.throws(
    () => injectSearchRpcTracer(`${apiManager}\n${duplicateInitialization}`),
    /already instrumented source has unexpected or ambiguous hooks/
  );
});

test('gated scroll samples record RAF gaps without screencast, tracing or CPU profiles', () => {
  const gatedScroll = performanceScale.match(/const scroll = await test\.step\('scroll back 2,000 messages'[\s\S]*?if\(!scroll\)/)?.[0];
  const diagnosticScroll = performanceScale.match(/const scrolled = await test\.step\(`profile 100x scroll back 2,000 messages[\s\S]*?if\(!scrolled/)?.[0];

  assert.ok(gatedScroll, 'the gated scroll scenario must be present');
  assert.doesNotMatch(gatedScroll, /capturePresentedFrames|Page\.startScreencast/);
  assert.match(gatedScroll, /pauseLongAnimationFrames: true/);
  assert.doesNotMatch(performanceScale, /startPresentedFrameCapture|presentedFrames|presentedDropped/);
  assert.doesNotMatch(gatedScroll, /captureCpuStacks|captureFrameTrace|captureWorkerMessages|includeLongTaskTrace/);
  assert.ok(diagnosticScroll, 'the separate diagnostic scroll pass must be present');
  assert.match(diagnosticScroll, /captureCpuStacks: true/);
  assert.match(diagnosticScroll, /traceRpc: true/);
});

test('unprofiled scroll retains timing-only tasks for the walk-mirror gate', () => {
  const capture = performanceScale.match(/async function capture\([\s\S]*?(?=\nasync function readCachedDialogReconcileSnapshot)/)?.[0];

  assert.ok(capture, 'the performance capture function must be present');
  assert.match(capture, /const longTaskTrace = includeLongTaskTrace \|\| collectWalkDiagnostics\s+\? summarizeLongTaskTrace\(longTasks, includeLongTaskTrace \? longAnimationFrames : \[\]/);
  assert.match(capture, /\.\.\.\(includeLongTaskTrace \|\| collectWalkDiagnostics \? \{longTaskTrace\} : \{\}\)/);
});

test('performance workflow does not run the removed screencast frame measurement test', () => {
  const browserStep = workflow.match(/- name: Run scale browser scenarios[\s\S]*?(?=\n      - name: Write performance summary)/)?.[0];

  assert.ok(browserStep, 'the performance browser step must be present');
  assert.doesNotMatch(browserStep, /performancePresentedFrames\.spec\.ts/);
});

test('sticker timing gates against the PR base and keeps the pre-178 client report-only', () => {
  assert.match(performanceClientBuild, /cat \.github\/perf-sticker-base-commit/);
  assert.match(performanceClientBuild, /teagram-web-sticker-base-dist/);
  assert.equal(stickerBaseCommit, 'e28fb469fa0404c5ea396c0230d0c4c94bf20c5b');
  assert.match(stickerBaseCommit, /^[a-f0-9]{40}$/);
  assert.match(performanceClientBuild, /PERF_STICKER_BASE_ORIGIN=http:\/\/localhost:4179/);
  assert.match(workflow, /TG_WEBSOCKET_ALLOWED_ORIGINS=.*4179/);
  assert.match(workflow, /serve-dist\.mjs "\$PERF_STICKER_BASE_DIST" 4179/);
  assert.match(performanceScale, /PERF_STICKER_BASE_ORIGIN/);
  assert.match(performanceScale, /stickerRuns\.base = preparedVariants\['1x'\]\.base!/);
  assert.match(performanceScale, /stickerRuns\.pinned = firstStickerPinnedRun!/);
  assert.match(performanceScale, /expect\(firstVisibleChatList\.source\)\.toBe\('snapshot'\)/);
  assert.doesNotMatch(performanceScale, /firstVisibleChatList\.source\)\.toBe\((?:run\.)?variant === 'head'/);
});

test('cold sticker paint timing uses an endpoint after an intervening render', () => {
  assert.match(performanceScale, /scheduleAfterInterveningPaint\.toString\(\)/);
  assert.match(performanceScale, /__teagramScheduleAfterInterveningPaint\(\(nextPaintAt: number\)/);
  assert.doesNotMatch(performanceScale, /requestAnimationFrame\(\(\) => timing\.nextPaintAt/);
});

test('base and head both require date-jump and 2,000-message scroll-back samples', () => {
  assert.match(performanceScale, /scrollBackTwoThousand\(\s*(?:chatOpenPage|page),\s*(?:chatOpenRequests|requests),\s*true,/);
  assert.match(performanceScale, /jumpToFixtureDate\((?:chatOpenPage|page), (?:chatOpenRequests|requests), fixture, false, undefined, collectWalkDiagnostics\)/);
  assert.doesNotMatch(performanceScale, /allowUnsupportedBase/);
  assert.doesNotMatch(performanceScale, /base build may (?:not reach|lack)/);
  assert.match(performanceScale, /if\(!scroll\) throw new Error/);
  assert.match(performanceScale, /if\(!jump\) throw new Error/);
  assert.match(performanceScale, /for\(let round = 0; round < PERFORMANCE_REPEATS; \+\+round\)/);
});

test('full trace diagnostics use one paired pass while walk gates keep nine measured samples', () => {
  assert.match(performanceScale, /const TRACE_DIAGNOSTIC_REPEATS = 1/);
  assert.match(performanceScale, /for\(let repeat = 0; repeat < TRACE_DIAGNOSTIC_REPEATS; \+\+repeat\)/);
  assert.match(performanceScale, /buildWalkComparison\([\s\S]*?PERFORMANCE_REPEATS/);
  assert.match(performanceScale, /validateCachedDialogReconcileDiagnostics\(samples, scenario, PERFORMANCE_REPEATS\)/);
  assert.match(performanceScale, /validateCachedDialogReconcileDiagnostics\(traceSamples\[scenario\], scenario, TRACE_DIAGNOSTIC_REPEATS, requireWalk\)/);
  assert.doesNotMatch(performanceScale, /for\(let repeat = 0; repeat < PERFORMANCE_REPEATS; \+\+repeat\)[\s\S]{0,250}rpcComparison/);
});

test('global-search measurements include the first matching query without a prewarm request', () => {
  const globalSearch = performanceScale.match(/async function globalSearch\([\s\S]*?(?=\nasync function describeSendState)/)?.[0];
  assert.ok(globalSearch, 'the performance scenario must define global search');
  assert.doesNotMatch(performanceScale, /warmGlobalSearch|globalSearchWarmup/);
  const measurementStart = globalSearch.indexOf('await beginScenario(page, requests, traceEnabled);');
  const traceReset = globalSearch.indexOf('resetPerformanceRpcTrace(true)');
  const measuredQuery = globalSearch.indexOf('await input.fill(query);', traceReset);
  const queryFills = globalSearch.match(/await input\.fill\(query\);/g) || [];
  assert.ok(measurementStart >= 0 && measurementStart < traceReset && traceReset < measuredQuery, 'the first search must run inside the measured RPC trace');
  assert.equal(queryFills.length, 1, 'each sample must issue one query, without an earlier warm-up request');
  assert.match(globalSearch, /globalSearchBaselineRows = new WeakSet\(document\.querySelectorAll\('#search-container \.chatlist-chat'\)\)/);
  assert.match(globalSearch, /await waitForGlobalSearchResult\(page, query, true\)/);
});

test('only pull requests build and require a base comparison', () => {
  assert.doesNotMatch(workflow, /workflow_dispatch:|performance_base_sha|github\.event\.inputs/);
  const checkoutStep = workflow.match(/- name: Check out web client([\s\S]*?)(?=\n      - name: Set performance output paths)/)?.[1];
  assert.ok(checkoutStep, 'the performance workflow must define its client checkout step');
  assert.doesNotMatch(checkoutStep, /^\s+ref:/m, 'the checkout must use the event head');
  assert.match(workflow, /PERF_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /PERF_REQUIRE_BASE: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('performance tracing uses a separate diagnostic bundle', () => {
  assert.match(performanceClientBuild, /VITE_PERF_RECONCILE_TRACE=1 VITE_PERF_SEARCH_TRACE=1 VITE_PERF_HISTORY_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-head-dist"/);
  assert.match(performanceClientBuild, /VITE_PERF_RECONCILE_TRACE=1 VITE_PERF_SEARCH_TRACE=1 VITE_PERF_HISTORY_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-base-dist"/);
  assert.match(performanceClientBuild, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-trace-dist"/);
  assert.match(performanceClientBuild, /PERF_TRACE_HEAD_ORIGIN_100X=http:\/\/localhost:4177/);
  assert.match(workflow, /TG_WEBSOCKET_ALLOWED_ORIGINS=.*http:\/\/localhost:4177/);
});

test('snapshot date formatting does not request the lazy date chunk', () => {
  assert.doesNotMatch(chatPageSnapshotView, /from ['"]@helpers\/date['"]/);
  assert.match(chatPageSnapshotView, /IntlDateElement/);
});

test('chat-list metrics wait for the snapshot to be replaced by live rows', () => {
  const waitForChatList = performanceScale.match(/async function waitForChatList\(page: Page\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(waitForChatList, 'the performance scenario must wait for its chat list');
  assert.match(performanceScale, /observeFirstVisibleChatList\.toString\(\)/, 'first-visible timing must be observed from document startup');
  const firstPaintWait = waitForChatList.indexOf('await waitForFirstVisibleChatList(page)');
  const snapshotWait = waitForChatList.indexOf("page.locator('.chat-page-snapshot')");
  const liveRowsWait = waitForChatList.indexOf("page.locator('#page-chats #folders-container .chatlist-chat')");
  assert.ok(firstPaintWait >= 0 && firstPaintWait < snapshotWait, 'first paint must be recorded before waiting for replacement');
  assert.ok(snapshotWait >= 0, 'snapshot rows must be absent before sampling');
  assert.ok(liveRowsWait > snapshotWait, 'live rows must be visible after the snapshot is gone');
  assert.match(waitForChatList.slice(snapshotWait), /toHaveCount\(0/);
  assert.match(waitForChatList.slice(liveRowsWait), /toBeVisible/);
  assert.match(performanceScale, /ms: boundary\.firstVisibleChatListMs \?\? boundary\.ms/);
  assert.match(performanceScale, /liveBoundaryMs: boundary\.ms/);
  assert.match(performanceScale, /requestBreakdownByPath\?\.clear\(\)/, 'request diagnostics must be sampled and reset per measurement');
  assert.match(performanceScale, /includeRequestBreakdown/);
  assert.match(performanceScale, /requestBreakdown\}/);
});

test('Playwright reports a performance-test timeout before the job is cancelled', () => {
  const jobTimeoutMinutes = Number(workflow.match(/^\s+timeout-minutes:\s*(\d+)/m)?.[1]);
  const testTimeoutMinutes = Number(playwrightConfig.match(/^\s+timeout:\s*(\d+)\s*\*\s*60\s*\*\s*1000/m)?.[1]);

  assert.ok(testTimeoutMinutes > 0, 'the performance test timeout must be configured');
  assert.ok(testTimeoutMinutes < jobTimeoutMinutes, 'the Playwright timeout must leave time for summary and artifact upload');
  assert.match(playwrightConfig, /reporter:\s*\[\['list',\s*\{printSteps:\s*true\}\]\]/, 'the reporter must stream in-progress scenario steps');
});

test('a hung browser action fails its own step instead of consuming the test timeout', () => {
  assert.match(playwrightConfig, /actionTimeout:\s*60_000/);
});

test('timing regressions use the paired blocking policy and the negative control still fails', () => {
  assert.doesNotMatch(performanceScale, /isWithinFirstStickerRegressionBudget/);
  assert.match(performanceScale, /coldLoadEvaluation\.blockingFailures/);
  assert.match(performanceScale, /100 ms control was not detected as a blocking regression/);
  assert.match(workerReplay, /pairedDeltaSamples/);
});

test('summary fails closed for missing, invalid, and short first-sticker sample artifacts', () => {
  const invalid = firstStickerMeasurements();
  invalid.samples.head.cold[0].clickToNextPaintMs = null;
  const short = firstStickerMeasurements();
  short.samples.head.warm.pop();
  const cases = [
    {firstSticker: null, failure: `first sticker timing samples are missing or do not contain ${PERFORMANCE_REPEATS} cold repeats`},
    {firstSticker: invalid, failure: `first sticker head cold sample set is missing, invalid, or does not contain ${PERFORMANCE_REPEATS} repeats`},
    {firstSticker: short, failure: 'first sticker head warm sample set is missing, invalid, or does not contain 3 repeats'}
  ];

  for(const {firstSticker, failure} of cases) {
    const result = runSummaryWithArtifacts({firstSticker});

    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(failure), result.stdout);
  }
});

test('summary rejects cold first-sticker samples when the worker was ready before chat opened', () => {
  const firstSticker = firstStickerMeasurements();
  firstSticker.samples.base.cold[0].workerReadyBeforeChat = true;

  const result = runSummaryWithArtifacts({firstSticker});

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /first sticker base cold worker was ready before chat opened/);
});

test('summary keeps a preloaded pinned client report-only and outside the cold gate', () => {
  const firstSticker = firstStickerMeasurements();
  firstSticker.samples.pinned.cold.forEach((sample) => {
    sample.workerReadyBeforeChat = true;
    sample.clickToWorkerRequestMs = -50;
    sample.pageTimestamps = {clickAt: 100, workerRequestAt: 50, firstFrameAt: 200, nextPaintAt: 220};
    sample.clickToFirstFrameMs = 100;
    sample.clickToNextPaintMs = 120;
    sample.firstFrameToNextPaintMs = 20;
  });
  firstSticker.medians.pinned.cold = {
    workerRequestMs: -50,
    workerFrameMs: 100,
    paintedFrameMs: 120,
    firstFrameToPaintMs: 20
  };

  const result = runSummaryWithArtifacts({firstSticker});

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Pinned baseline worker was ready before chat in 3\/3 report-only samples; excluded from cold gate pairs/);
});

test('summary fails closed for missing, invalid, and short worker-recorder artifacts', () => {
  const invalid = workerRecorderMeasurements();
  invalid.peers.pairedDeltaMs = null;
  invalid.peers.pairedDeltaSamples = null;
  const short = workerRecorderMeasurements();
  short.dialogs.iterations = 49;
  const cases = [
    {recorderReplay: null, failure: 'worker recorder replay measurements are missing'},
    {recorderReplay: invalid, failure: 'worker recorder peers sample set is missing, invalid, or shorter than 50 iterations'},
    {recorderReplay: short, failure: 'worker recorder dialogs sample set is missing, invalid, or shorter than 50 iterations'}
  ];

  for(const {recorderReplay, failure} of cases) {
    const result = runSummaryWithArtifacts({recorderReplay});

    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(failure), result.stdout);
  }
});

test('master runs still block when deterministic timing artifacts are missing', () => {
  const result = runSummaryWithArtifacts({requireBase: false, eventName: 'push', firstSticker: null, recorderReplay: null});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /first sticker timing samples are missing/);
  assert.match(result.stderr, /worker recorder replay measurements are missing/);
});

test('summary blocks first-sticker and worker-recorder regressions using the paired lower bound', () => {
  const firstSticker = firstStickerMeasurements();
  firstSticker.samples.head.cold = Array.from({length: PERFORMANCE_REPEATS}, () => ({
    workerReadyBeforeChat: false,
    clickToWorkerRequestMs: 15,
    clickToFirstFrameMs: 160,
    clickToNextPaintMs: 301,
    firstFrameToNextPaintMs: 141,
    pageTimestamps: {clickAt: 0, workerRequestAt: 15, firstFrameAt: 160, nextPaintAt: 301},
    clickToVisibleFrameMs: 301
  }));
  firstSticker.medians.head.cold = {workerRequestMs: 15, workerFrameMs: 160, paintedFrameMs: 301, firstFrameToPaintMs: 141};
  const recorderReplay = workerRecorderMeasurements();
  recorderReplay.peers.pairedDeltaMs = 3;
  recorderReplay.peers.pairedDeltaSamples = Array(9).fill(3);

  const result = runSummaryWithArtifacts({firstSticker, recorderReplay});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /first sticker cold next painted frame: one-sided 95% median lower bound 101\.0 ms exceeded minimum effect 100 ms/);
  assert.match(result.stderr, /worker recorder peers: one-sided 95% median lower bound 3\.0 ms exceeded minimum effect 1\.5 ms/);
});

test('summary fails closed when a 100x chat-open server duration is missing', () => {
  const result = runSummaryWithArtifacts({includeChatOpenServerRecords: false});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /100x chatOpen .*has missing or invalid messages\.getHistory server durations/);
});

test('summary requires RPC wall and non-RPC timing for each 100x chat-open gate sample', () => {
  const result = runSummaryWithArtifacts({includeChatOpenClientRpcData: false});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /100x chatOpen gate sample base sample 1 is missing total, RPC wall, or non-RPC timing/);
});

test('summary fails closed when server traces omit client getHistory handlers', () => {
  const result = runSummaryWithArtifacts({chatOpenClientHistoryCallCount: 2});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /has 1 server records for 2 client messages\.getHistory spans/);
});

test('summary fails closed for missing or duplicate client call identities', () => {
  const result = runSummaryWithArtifacts({
    chatOpenClientHistoryCallCount: 2,
    chatOpenServerHistoryRecordCount: 2,
    mutateReport(report) {
      report.variants.base['100x'].chatOpen[0].serverRpcClientCalls[1].callId = 1;
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /has missing or duplicate client RPC identities/);
});

test('summary preserves extra server handlers when the client records fewer calls', () => {
  const result = runSummaryWithArtifacts({chatOpenServerHistoryRecordCount: 2});

  assert.equal(result.status, 0);
});

test('summary subtracts the gate-clipped union of overlapping server handler intervals', () => {
  const result = runSummaryWithArtifacts({chatOpenServerHistoryRecordCount: 2, chatOpenClientHistoryCallCount: 2});

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Gate-clipped getHistory client union minus server interval union \(ms\)/);
  assert.match(result.stdout, /gate sample \| base \| 1 \| 100\.0 \| 60\.0 \| 40\.0 \| 40\.1 ms \(success\), 40\.1 ms \(success\) \| 18\.9 \|/);
});

test('summary only tolerates a server interval union larger than the client union within clock tolerance', () => {
  const setServerOverhang = (report, durationUs) => {
    const samples = ['base', 'head'].flatMap((variant) => [
      ...report.variants[variant]['100x'].chatOpen,
      ...report.diagnostics['100x'].rpcComparison[variant].chatOpen
    ]);
    for(const sample of samples) {
      const {startEpochMs} = sample.serverRpcGateWindow;
      sample.serverRpcClientCalls = [{
        callId: 1,
        method: 'messages.getHistory',
        startedAtEpochMs: startEpochMs + 10,
        durationMs: 60,
        outcome: 'success'
      }];
      sample.serverRpcRecords = [{
        method: 'messages.getHistory',
        duration_us: durationUs,
        result: 'success',
        end_unix_ms: startEpochMs + 75
      }];
    }
  };
  const withinTolerance = runSummaryWithArtifacts({mutateReport(report) { setServerOverhang(report, 65_000); }});
  assert.equal(withinTolerance.status, 0, withinTolerance.stderr);
  assert.match(withinTolerance.stdout, /\| n\/a \|/);

  const outsideTolerance = runSummaryWithArtifacts({mutateReport(report) { setServerOverhang(report, 70_000); }});
  assert.equal(outsideTolerance.status, 1);
  assert.match(outsideTolerance.stderr, /server messages\.getHistory interval union exceeds client getHistory interval union/);
});

test('summary excludes correlated client and server work wholly after the chat-open gate', () => {
  const result = runSummaryWithArtifacts({
    mutateReport(report) {
      const samples = ['base', 'head'].flatMap((variant) => report.variants[variant]['100x'].chatOpen);
      samples.push(...['base', 'head'].flatMap((variant) => report.diagnostics['100x'].rpcComparison[variant].chatOpen));
      for(const sample of samples) {
        const gateEnd = sample.serverRpcGateWindow.endEpochMs;
        sample.rpcCallCount = 0;
        sample.rpcWallMs = 0;
        sample.nonRpcElapsedMs = sample.ms;
        sample.rpcCalls = [];
        sample.serverRpcClientCalls = [{callId: 1, method: 'messages.getHistory', startedAtEpochMs: gateEnd + 10, durationMs: 60, outcome: 'success'}];
        sample.serverRpcRecords = [{method: 'messages.getHistory', duration_us: 40_123, result: 'success', end_unix_ms: Math.round(gateEnd + 63)}];
      }
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gate sample \| base \| 1 \| 100\.0 \| 0\.0 \| 100\.0 \| 40\.1 ms \(success\) \| 0\.0 \|/);
});

test('100x chat-open gate captures call identities at its boundary and settles only those spans', () => {
  const gateCall = performanceScale.match(/const chatOpen = await test\.step\('open scale fixture chat',[\s\S]*?\);/)?.[0];
  const capture = performanceScale.match(/async function capture\([\s\S]*?(?=\nasync function readCachedDialogReconcileSnapshot)/)?.[0];
  const openPartnerChat = performanceScale.match(/async function openPartnerChat\([\s\S]*?(?=\nasync function scrollBackTwoThousand)/)?.[0];
  const attachServerRpcTrace = performanceScale.match(/async function attachServerRpcTrace\([\s\S]*?(?=\ntest\.afterAll)/)?.[0];
  const finalizeServerRpcTrace = performanceScale.match(/async function finalizeServerRpcTrace\([\s\S]*?(?=\nasync function reloadChatList)/)?.[0];
  const diagnosticChatOpen = performanceScale.match(/const chatOpenBoundary = await waitForFirstVisibleBubble\(page\);[\s\S]*?traceSamples\.chatOpen\.push\(chatOpenSample\);/)?.[0];
  const mainScenarioFlow = performanceScale.match(/const chatOpen = await test\.step\('open scale fixture chat',[\s\S]*?await finalizeServerRpcTrace\(page, chatOpen\);/)?.[0];

  assert.ok(gateCall, 'the gated chat-open scenario must be present');
  assert.match(gateCall, /openPartnerChat\(page, requests, fixture, scale === '100x', collectWalkDiagnostics, scale === '100x'\)/);
  assert.ok(capture, 'the capture helper must be present');
  assert.match(capture, /captureRpcTrace/);
  assert.match(capture, /serverRpcGateWindow/);
  assert.match(capture, /rpcInvocationsInWindow\(rpcRawCalls\.map\(\(call, callId\) => \(\{\.\.\.call, callId\}\)\)\.filter\(\(call\) => call\.method === 'messages\.getHistory'\), timeOrigin, boundary\.startedAtMs, boundary\.ms\)/, 'base bundles keep trace positions paired with start times without adding app trace call ids');
  assert.doesNotMatch(performanceTrace, /callId/, 'the app trace must not grow a call id that base bundles lack');
  assert.ok(openPartnerChat, 'the chat-open helper must be present');
  assert.doesNotMatch(openPartnerChat, /waitForHistorySettled/);
  assert.match(openPartnerChat, /capture\(page, requests, boundary, false, false, collectWalkDiagnostics, false, collectWalkDiagnostics, traceRpc, collectServerRpcTrace\)/);
  assert.match(capture, /captureServerRpcClientCalls/);
  assert.ok(attachServerRpcTrace, 'server handler records must be correlated before attachment');
  assert.match(attachServerRpcTrace, /serverRpcRecordsCoverClientCalls/);
  assert.match(attachServerRpcTrace, /readServerRpcTraceRecordsSince/);
  assert.match(attachServerRpcTrace, /\.filter\(\(record\) => serverRpcRecordMatchesClientCalls\(record, clientCalls\)\)/, 'all completed correlated handlers must be retained without polling for a quiet period');
  assert.doesNotMatch(attachServerRpcTrace, /quietMs|waitForServerRpcTraceRecords/);
  assert.ok(finalizeServerRpcTrace, 'the captured chat-open identities must settle before server records attach');
  assert.match(finalizeServerRpcTrace, /const callIds = boundaryCalls\.map\(\(call\) => call\.callId\)/);
  assert.match(finalizeServerRpcTrace, /Number\.isFinite\(boundaryCalls\[index\]\.startedAtEpochMs\)/);
  assert.match(finalizeServerRpcTrace, /Object\.fromEntries\(callIds\.map/, 'settlement should transfer only the boundary calls instead of the full accumulated trace');
  assert.match(finalizeServerRpcTrace, /serverRpcClientCallsByIdentity\(currentCalls, boundaryCalls\)/);
  assert.ok(finalizeServerRpcTrace.includes('if(!callIds.length)'), 'zero-call cold samples must fail before a server trace can be attributed');
  assert.ok(finalizeServerRpcTrace.includes('has no in-gate client messages.getHistory spans'), 'the failure should include trace correlation details');
  assert.match(finalizeServerRpcTrace, /serverRpcClientCallsAreSettled\(boundaryCalls\)/, 'already-settled boundary calls should attach without another browser polling round trip');
  assert.ok(finalizeServerRpcTrace.indexOf('serverRpcClientCallsAreSettled(boundaryCalls)') < finalizeServerRpcTrace.indexOf('const settledCallsHandle = await page.waitForFunction'), 'the settled snapshot fast path must run before browser polling');
  assert.doesNotMatch(finalizeServerRpcTrace, /calls\[callId\]/, 'settlement must reject a trace reset instead of silently remapping boundary indices');
  assert.match(finalizeServerRpcTrace, /page\.waitForFunction/);
  assert.doesNotMatch(finalizeServerRpcTrace, /expect\.poll/);
  assert.doesNotMatch(finalizeServerRpcTrace, /waitForHistorySettled/);
  assert.match(finalizeServerRpcTrace, /Object\.assign\(sample, await attachServerRpcTrace/);
  assert.ok(mainScenarioFlow, 'the main gated scenario sequence must be present');
  assert.ok(mainScenarioFlow.search(/test\.step\('scroll back 2,000 messages'/) < mainScenarioFlow.indexOf('finalizeServerRpcTrace(page, chatOpen)'), 'history telemetry must finalize after the scroll-back gate');
  assert.ok(mainScenarioFlow.search(/test\.step\('jump to fixture date'/) < mainScenarioFlow.indexOf('finalizeServerRpcTrace(page, chatOpen)'), 'history telemetry must finalize after the date-jump gate');
  assert.ok(diagnosticChatOpen, 'the RPC diagnostic chat-open sample must be present');
  assert.doesNotMatch(diagnosticChatOpen, /await waitForHistorySettled\(page\)/);
  assert.match(diagnosticChatOpen, /finalizeServerRpcTrace\(page, chatOpenSample\)/);
});

test('100x chat-open closes the active peer and waits for the history flush acknowledgement', () => {
  const prepare = performanceScale.match(/async function prepareColdChatOpenStartState[\s\S]*?(?=\nfunction expectChatOpenHistoryCall)/)?.[0];

  assert.ok(prepare, 'cold-history preparation should be isolated before the measured click');
  assert.match(prepare, /if\(appImManager\.chat\?\.peerId\) await appImManager\.setPeer\(\{\}\)/, 'close an active chat before re-opening the fixture peer');
  assert.match(prepare, /if\(appImManager\.chat\?\.peerId\) throw new Error/, 'fail if the active chat did not close');
  assert.match(prepare, /await expect\(page\.locator\(`\.bubbles \.bubble\[data-peer-id=/, 'do not start a gate while stale fixture bubbles remain visible');
  assert.match(prepare, /await \(window as any\)\.rootScope\.managers\.appMessagesManager\.flushStoragesByPeerId\(peerId\)/);
  assert.match(prepare, /await \(window as any\)\.apiManagerProxy\.invoke\('mirrorQueueBarrier', undefined\)/);
  assert.ok(prepare.indexOf('flushStoragesByPeerId') < prepare.indexOf("invoke('mirrorQueueBarrier'"), 'the worker acknowledgement must follow the cache deletion request');
  assert.doesNotMatch(prepare, /Promise\.all/, 'do not acknowledge mirror deletions before the asynchronous manager call has completed');
  assert.doesNotMatch(prepare, /getMemoryStats/, 'the queue acknowledgement is the ordering barrier; do not scan worker state');
  assert.match(mainMessagePort, /mirrorQueueBarrier: \(payload: void\) => void/);
  assert.match(mainWorker, /mirrorQueueBarrier:\s*\(\) => \{[\s\S]*?earlier worker-to-window mirror messages[\s\S]*?\}/);
  assert.match(performanceScale, /if\(collectServerRpcTrace\) await prepareColdChatOpenStartState\(page, fixture\)/);
  assert.ok(performanceScale.includes('await prepareColdChatOpenStartState(page, fixture)'));
  assert.ok(performanceScale.includes('expectChatOpenHistoryCall(chatOpen'));
  assert.ok(performanceScale.includes('expectChatOpenHistoryCall(chatOpenSample'));
  assert.ok(performanceScale.includes('scrollBackTwoThousand(\n      page'));
  assert.ok(performanceScale.includes('jumpToFixtureDate(page'));
});

test('100x chat-open resets history without changing adjacent scenario sequencing', () => {
  const beforeAll = performanceScale.match(/test\.beforeAll\(async\(\{browser\}\) => \{[\s\S]*?\n\}\);/)?.[0];
  const runVariant = performanceScale.match(/async function runVariant\([\s\S]*?(?=\nasync function traceDateJump)/)?.[0];
  const traceTargetScenarios = performanceScale.match(/async function traceTargetScenarios\([\s\S]*?(?=\ntest\('measures the scale fixture)/)?.[0];
  const openPartnerChat = performanceScale.match(/async function openPartnerChat\([\s\S]*?(?=\nasync function scrollBackTwoThousand)/)?.[0];

  assert.ok(beforeAll && runVariant && traceTargetScenarios && openPartnerChat);
  assert.match(performanceScale, /prepareColdChatOpenStartState/, 'cold-history preparation must happen before the measured click');
  assert.doesNotMatch(openPartnerChat, /waitForHistorySettled|flushStoragesByPeerId/);
  assert.doesNotMatch(traceTargetScenarios, /flushStoragesByPeerId|structuredClone/);
  assert.match(runVariant, /openPartnerChat\(page, requests, fixture, scale === '100x'/);
  assert.match(runVariant, /resetToChatList\(page, origin\)/);
});

test('summary fails closed when a cold chat-open gate issued no getHistory', () => {
  const result = runSummaryWithArtifacts({
    chatOpenClientHistoryCallCount: 0,
    chatOpenServerHistoryRecordCount: 0,
    chatOpenServerClientHistoryCallCount: 0
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cold 100x chatOpen gate sample base sample 1 has no client messages\.getHistory span/);
});

test('summary fails closed when a cold chat-open RPC diagnostic issued no getHistory', () => {
  const result = runSummaryWithArtifacts({
    mutateReport(report) {
      const sample = report.diagnostics['100x'].rpcComparison.base.chatOpen[0];
      sample.serverRpcClientCalls = [];
      sample.rpcCalls = [];
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cold 100x chatOpen RPC diagnostic base sample 1 has no client messages\.getHistory span/);
});

test('summary fails closed when a zero-call sample attaches an uncorrelated process-wide handler', () => {
  const result = runSummaryWithArtifacts({
    chatOpenClientHistoryCallCount: 0,
    chatOpenServerClientHistoryCallCount: 1,
    mutateReport(report) {
      report.variants.base['100x'].chatOpen[0].serverRpcClientCalls = [];
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cold 100x chatOpen gate sample base sample 1 has no client messages\.getHistory span/);
});

test('summary rejects a process-wide server handler outside the client sample span', () => {
  const result = runSummaryWithArtifacts({
    mutateReport(report) {
      const sample = report.variants.base['100x'].chatOpen[0];
      sample.serverRpcClientCalls = [{...sample.serverRpcClientCalls[0], startedAtEpochMs: 1_762_800_001_000}];
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot correlate server messages\.getHistory records to client spans/);
});

test('summary reports nine paired samples and keeps extra diagnostic samples out of the gate', () => {
  const scenarioKeys = ['coldChatList', 'warmChatList', 'chatOpen', 'scrollBack2k', 'dateJump', 'contactsList', 'contactSearch', 'globalSearch', 'sendMessage'];
  const makeSample = (ms, key) => ({
    ms,
    ...(key === 'globalSearch' ? {
      globalSearchStages: {
        queryEnteredAtMs: 100,
        debounceSettledAtMs: 120,
        matchingSearchRpcReturnedAtMs: 150,
        matchingResultVisibleAtMs: 100 + ms
      }
    } : {}),
    firstVisibleChatListMs: ms,
    firstVisibleChatListSource: 'snapshot',
    liveBoundaryMs: ms + 400,
    requests: 4,
    rpcCallCount: 2,
    domNodes: 100,
    bundleBytes: 10_000,
    longTasksOver50Ms: 0,
    blockingTimeMs: 0,
    maxLongTaskDurationMs: 0,
    frameIntervals: 100,
    droppedFrames: 0,
    droppedFramePercent: 0,
    rafDropped: 0,
    composerReadyAfterFirstBubbleMs: 50,
    firstBubbleToSentMs: ms + 50
  });
  const makeReport = (timingSamples, sendSamples) => {
    const variants = {};
    for(const variant of ['base', 'head']) {
      variants[variant] = {'1x': {}, '100x': {}};
      for(const key of scenarioKeys) {
        const count = PERFORMANCE_REPEATS;
        const samples = () => Array.from({length: count}, () => ({
          ...makeSample(100, key),
          ...(key === 'sendMessage' ? {appSendUiMs: 80} : {})
        }));
        variants[variant]['1x'][key] = samples();
        variants[variant]['100x'][key] = samples();
      }
    }
    const withServerHistory = (sample) => ({
      ...sample,
      serverRpcRecords: [{method: 'messages.getHistory', duration_us: 40_123, result: 'success', end_unix_ms: 1_762_800_000_063}]
    });
    const withChatOpenTimings = (sample) => ({
      ...sample,
      serverRpcGateWindow: {startEpochMs: 1_762_800_000_000, endEpochMs: 1_762_800_000_000 + sample.ms},
      rpcWallMs: 60,
      nonRpcElapsedMs: sample.ms - 60,
      serverRpcClientCalls: [{callId: 1, method: 'messages.getHistory', startedAtEpochMs: 1_762_800_000_000, durationMs: 60, outcome: 'success'}],
      rpcCalls: [{method: 'messages.getHistory', startedAtMs: 0, durationMs: 60, outcome: 'success'}]
    });
    variants.base['100x'].chatOpen = Array.from({length: PERFORMANCE_REPEATS}, () => withServerHistory(withChatOpenTimings(makeSample(100))));
    variants.head['100x'].chatOpen = timingSamples.map((ms) => withServerHistory(withChatOpenTimings(makeSample(ms))));
    const makeSendSample = (measurement) => {
      const {ms, appSendUiMs = ms - 20} = typeof measurement === 'number' ? {ms: measurement} : measurement;
      return {...makeSample(ms), appSendUiMs};
    };
    variants.base['100x'].sendMessage = sendSamples.base.map(makeSendSample);
    variants.head['100x'].sendMessage = sendSamples.head.map(makeSendSample);
    return {
      measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
      fixtureVersion: 'fixture-v1',
      serverCommit: 'server-v1',
      fixtureServerCommit: 'fixture-server-v1',
      requireBase: true,
      diagnostics: {
        firstSticker: {
          repeats: PERFORMANCE_REPEATS,
          samples: {
            base: {cold: Array.from({length: PERFORMANCE_REPEATS}, () => ({workerReadyBeforeChat: false, clickToWorkerRequestMs: 10, clickToFirstFrameMs: 100, clickToNextPaintMs: 200, firstFrameToNextPaintMs: 100, pageTimestamps: {clickAt: 0, workerRequestAt: 10, firstFrameAt: 100, nextPaintAt: 200}})), warm: Array.from({length: 3}, () => ({clickToFirstFrameMs: 75, clickToVisibleFrameMs: 150}))},
            head: {cold: Array.from({length: PERFORMANCE_REPEATS}, () => ({workerReadyBeforeChat: false, clickToWorkerRequestMs: 12, clickToFirstFrameMs: 140, clickToNextPaintMs: 280, firstFrameToNextPaintMs: 140, pageTimestamps: {clickAt: 0, workerRequestAt: 12, firstFrameAt: 140, nextPaintAt: 280}})), warm: Array.from({length: 3}, () => ({clickToFirstFrameMs: 105, clickToVisibleFrameMs: 210}))},
            pinned: {cold: Array.from({length: 3}, () => ({workerReadyBeforeChat: false, clickToWorkerRequestMs: 11, clickToFirstFrameMs: 90, clickToNextPaintMs: 180, firstFrameToNextPaintMs: 90, pageTimestamps: {clickAt: 0, workerRequestAt: 11, firstFrameAt: 90, nextPaintAt: 180}})), warm: []}
          },
          medians: {
            base: {cold: {workerRequestMs: 10, workerFrameMs: 100, paintedFrameMs: 200, firstFrameToPaintMs: 100}, warm: {workerFrameMs: 75, visibleFrameMs: 150}},
            head: {cold: {workerRequestMs: 12, workerFrameMs: 140, paintedFrameMs: 280, firstFrameToPaintMs: 140}, warm: {workerFrameMs: 105, visibleFrameMs: 210}},
            pinned: {cold: {workerRequestMs: 11, workerFrameMs: 90, paintedFrameMs: 180, firstFrameToPaintMs: 90}}
          }
        },
        '100x': {
          walkComparison: Object.fromEntries(['base', 'head'].map((variant) => [variant, Object.fromEntries(scenarioKeys.map((key) => [
            key,
            Array.from({length: PERFORMANCE_REPEATS}, () => ({walkLongTasksOver50Ms: 0}))
          ]))])),
          chatOpen: [{
            ms: 377,
            serverRpcGateWindow: {startEpochMs: 1_762_800_000_000, endEpochMs: 1_762_800_000_377},
            rpcCallCount: 1,
            rpcWallMs: 377,
            nonRpcElapsedMs: 0,
            rpcCalls: [{method: 'messages.getHistory', durationMs: 377, outcome: 'success'}],
            serverRpcClientCalls: [{callId: 1, method: 'messages.getHistory', startedAtEpochMs: 1_762_800_000_000, durationMs: 377, outcome: 'success'}],
            serverRpcRecords: [{method: 'messages.getHistory', duration_us: 40_123, result: 'success', end_unix_ms: 1_762_800_000_123}]
          }],
          rpcComparison: Object.fromEntries(['base', 'head'].map((variant) => [variant, {
            chatOpen: [{
              ms: 377,
              serverRpcGateWindow: {startEpochMs: 1_762_800_000_000, endEpochMs: 1_762_800_000_377},
              rpcCallCount: 1,
              rpcWallMs: 377,
              nonRpcElapsedMs: 0,
              rpcCalls: [{method: 'messages.getHistory', durationMs: 377, outcome: 'success'}],
              serverRpcClientCalls: [{callId: 1, method: 'messages.getHistory', startedAtEpochMs: 1_762_800_000_000, durationMs: 377, outcome: 'success'}],
              serverRpcRecords: [{method: 'messages.getHistory', duration_us: 40_123, result: 'success', end_unix_ms: 1_762_800_000_123}]
            }]
          }])),
          sendMessage: [{
            ms: 123,
            appSendUiMs: 101,
            requests: 0,
            domNodes: 1_000,
            domNodeCounts: {bubbleGroups: 12},
            longTasksOver50Ms: 0,
            walkLongTasksOver50Ms: 0,
            blockingTimeMs: 0,
            rpcCallCount: 1,
            rpcWallMs: 81,
            nonRpcElapsedMs: 42,
            rpcCalls: [{method: 'messages.sendMessage', durationMs: 81, outcome: 'success'}],
            cpu: {topFrames: [{functionName: 'sendMessage', script: '/input.ts', selfMs: 22}]}
          }]
        }
      },
      variants
    };
  };
  const summaryFor = (timingSamples, sendSamples = {base: Array(9).fill(100), head: Array(9).fill(100)}, eventName = 'pull_request') => {
    const directory = mkdtempSync(join(tmpdir(), 'tweb-performance-summary-'));
    const reportPath = join(directory, 'report.json');
    const report = makeReport(timingSamples, sendSamples);
    const recorderReplayPath = join(directory, 'recorder-replay.json');
    writeFileSync(recorderReplayPath, JSON.stringify({
      peers: {offMs: 10, onMs: 11, pairedDeltaMs: 1, pairedDeltaSamples: Array(9).fill(1), iterations: 50},
      dialogs: {offMs: 10, onMs: 10.5, pairedDeltaMs: 0.5, pairedDeltaSamples: Array(9).fill(0.5), iterations: 50}
    }));
    const historyDirectory = join(directory, 'history');
    mkdirSync(historyDirectory);
    const historyVariants = JSON.parse(JSON.stringify(report.variants.head));
    historyVariants['100x'].chatOpen = Array.from({length: PERFORMANCE_REPEATS}, () => makeSample(100));
    historyVariants['100x'].sendMessage = historyVariants['100x'].sendMessage.slice(0, PERFORMANCE_REPEATS);
    writeFileSync(reportPath, JSON.stringify(report));
    for(let index = 0; index < 20; ++index) {
      writeFileSync(join(historyDirectory, `history-${index}.json`), JSON.stringify({
        measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
        fixtureVersion: report.fixtureVersion,
        serverCommit: report.serverCommit,
        fixtureServerCommit: report.fixtureServerCommit,
        variants: {head: historyVariants}
      }));
    }
    try {
      const result = spawnSync(process.execPath, [new URL('./write-summary.mjs', import.meta.url).pathname], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PERF_REPORT_PATH: reportPath,
          PERF_RECORDER_REPLAY_PATH: recorderReplayPath,
          PERF_HISTORY_DIRECTORY: historyDirectory,
          PERF_BROWSER_OUTCOME: 'success',
          GITHUB_EVENT_NAME: eventName,
          GITHUB_REF: eventName === 'push' ? 'refs/heads/master' : '',
          GITHUB_RUN_ID: 'zz-run',
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_STEP_SUMMARY: ''
        }
      });
      assert.equal(result.status, 0, result.stderr);
      if(eventName === 'push') {
        const savedHistory = JSON.parse(readFileSync(join(historyDirectory, 'zz-run-1.json'), 'utf8'));
        assert.equal(savedHistory.variants.base['100x'].sendMessage.length, PERFORMANCE_REPEATS);
        assert.equal(savedHistory.variants.head['100x'].sendMessage.length, PERFORMANCE_REPEATS);
      }
      return result.stdout;
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  };

  const nineSampleSummary = summaryFor(Array(9).fill(100));
  const extraSampleSummary = summaryFor([100, 100, 100, 100, 100, 100, 100, 100, 100, 900, 1_000]);
  const elevenSendSampleSummary = summaryFor(Array(9).fill(100), {
    base: [100, 100, 100, 200, 300, 400, 500, 600, 700, 800, 900],
    head: [100, 100, 100, 200, 300, 400, 500, 600, 700, 800, 1_100]
  }, 'push');
  const boundarySummary = summaryFor(Array(9).fill(100), {
    base: Array(PERFORMANCE_REPEATS).fill({ms: 599, appSendUiMs: 480}),
    head: Array(PERFORMANCE_REPEATS).fill({ms: 599, appSendUiMs: 480})
  });

  assert.match(extraSampleSummary, /Open long-history chat \| head \| 11 \| 1000\.0/);
  assert.match(elevenSendSampleSummary, /Send a message \| head \| 11 \| 1100\.0 \| 1080\.0 \| 50\.0 \| 1150\.0/);
  assert.match(nineSampleSummary, /100x send action diagnostic/);
  assert.match(nineSampleSummary, /### Chat-list paint and counter boundaries/);
  assert.match(nineSampleSummary, /### First animated sticker frame/);
  assert.match(nineSampleSummary, /\| base \| cold \| 9 \| 10\.0 \| 100\.0 \| 200\.0 \| n\/a \| 100\.0 \|/);
  assert.match(nineSampleSummary, /\| base \| warm \| 3 \| n\/a \| 75\.0 \| n\/a \| 150\.0 \| n\/a \|/);
  assert.match(nineSampleSummary, /PR base\/head cold next-painted-frame gate: paired SD 0\.0 ms; one-sided 95% median lower bound 80\.0 ms; minimum effect 100 ms; passed/);
  assert.match(nineSampleSummary, /Pinned pre-PR-178 cold next-painted-frame comparison: pinned 180\.0 ms, head 280\.0 ms, increase 100\.0 ms; report-only/);
  assert.match(nineSampleSummary, /### Worker recorder replay overhead/);
  assert.match(nineSampleSummary, /100x chat-open server handling/);
  assert.equal([...nineSampleSummary.matchAll(/\| gate sample \| base \|/g)].length, PERFORMANCE_REPEATS);
  assert.equal([...nineSampleSummary.matchAll(/\| gate sample \| head \|/g)].length, PERFORMANCE_REPEATS);
  assert.match(nineSampleSummary, /gate sample \| base \| 1 \| 100\.0 \| 60\.0 \| 40\.0 \| 40\.1 ms \(success\) \| 19\.9 \|/);
  assert.match(nineSampleSummary, /RPC diagnostic \| head \| 1 \| 377\.0 \| 377\.0 \| 0\.0 \| 40\.1 ms \(success\) \|/);
  assert.match(nineSampleSummary, /peers \| 10\.0 \| 11\.0 \| 1\.000 \|.*passed/);
  assert.match(nineSampleSummary, /Walk-mirror tasks >50 ms \(head max\/repeat\)/);
  assert.doesNotMatch(nineSampleSummary, /Blocking findings:/);
  assert.match(nineSampleSummary, /\| Scenario \| Scale \| Variant \| First visible \(ms\) \| First visible state \| Live boundary \(ms\) \| Requests \| RPC calls \| DOM nodes \| Long tasks >50 ms \| Blocking \(ms\) \| Bundle bytes \|/);
  assert.match(nineSampleSummary, /\| Cold chat list \| 1x \| head \| 100\.0 \| snapshot \| 500\.0 \| 4 \| 2 \| 100 \| 0 \| 0\.0 \| 10000 \|/);
  assert.match(nineSampleSummary, /\| 123\.0 \| 101\.0 \| 1 \| 81\.0 \| 42\.0 \| 0 \| 1000 \| 12 \| 0 \| 0\.0 \| messages\.sendMessage \(81\.0 ms, success\) \| sendMessage \/input\.ts \(22\.0 ms\) \|/);
  assert.match(boundarySummary, /`Send a message` is gated on `App Enter-to-bubble` \(`appSendUiMs`\)/);
  assert.match(boundarySummary, /\| Send a message, Enter-to-bubble \(100x\) \| 480\.0 \|/);
  assert.match(boundarySummary, /\| Send a message \| base \| 1 \| 599\.0 \| 480\.0 \|/);
});

test('performance workflow pins and enables the per-RPC server trace for 100x', () => {
  const serverCommit = readFileSync(new URL('../../.github/perf-server-commit', import.meta.url), 'utf8').trim();
  assert.equal(serverCommit, '11aca52138df628f0ef9972e0583c768d12c221d');
  assert.match(workflow, /PERF_SERVER_RPC_TRACE_FILE_100X/);
  const serverStep = workflow.match(/- name: Build fixture server and client bundles in parallel([\s\S]*?)(?=\n      - name: Start local HTTPS)/)?.[1];
  assert.ok(serverStep, 'the performance workflow must define its combined fixture server and client build step');
  assert.match(serverStep, /TG_RPC_TRACE_FILE/);
  assert.match(serverStep, /if \[ "\$scale" = "100x" \]; then\s+rpc_trace_env\+=\("TG_RPC_TRACE_FILE=\$PERF_SERVER_RPC_TRACE_FILE_100X"\)/);
  assert.match(workflow, /teagram-perf-server-rpc-100x\.jsonl/);
  assert.match(performanceClientBuild, /PERF_BASE_DIST=/);
  assert.match(performanceClientBuild, /node scripts\/performance\/inject-mirror-queue-barrier\.mjs "\$base_directory"/);
});

test('performance setup overlaps client bundles with fixture server compilation', () => {
  const buildStep = workflow.match(/- name: Build fixture server and client bundles in parallel([\s\S]*?)(?=\n      - name: Start local HTTPS)/)?.[1];

  assert.ok(buildStep, 'the performance workflow must define a combined server and client build step');
  const clientBuild = buildStep.indexOf('bash scripts/performance/build-client-bundles.sh "$client_build_env"');
  const clientPid = buildStep.indexOf('client_build_pid=$!');
  const serverBuild = buildStep.indexOf('go -C teagram-server build');
  const clientWait = buildStep.indexOf('wait "$client_build_pid"');
  const serverLaunch = buildStep.indexOf('nohup env TG_POSTGRES_DSN=');
  const baseBarrierInjection = performanceClientBuild.indexOf('node scripts/performance/inject-mirror-queue-barrier.mjs "$base_directory"');
  const baseTimingBuild = performanceClientBuild.indexOf('teagram-web-base-dist');
  const baseTraceBuild = performanceClientBuild.indexOf('teagram-web-base-trace-dist');

  assert.ok(clientBuild >= 0 && clientBuild < clientPid && clientPid < serverBuild, 'the client build must start in the background before the fixture server build');
  assert.ok(serverBuild < clientWait && clientWait < serverLaunch, 'both builds must finish before the fixture server starts and the browser services launch');
  assert.match(buildStep, /cat "\$client_build_env" >> "\$GITHUB_ENV"/);
  assert.match(buildStep, /if wait "\$client_build_pid"; then/);
  assert.match(performanceClientBuild, /VITE_PERF_RECONCILE_TRACE=1 VITE_PERF_SEARCH_TRACE=1 VITE_PERF_HISTORY_TRACE=1 pnpm exec vite build/);
  assert.ok(baseBarrierInjection >= 0 && baseBarrierInjection < baseTimingBuild && baseBarrierInjection < baseTraceBuild, 'the base worker must receive the test-only acknowledgement before either client bundle is built');
});

test('summary reports query stages for every global-search sample', () => {
  const result = runSummaryWithArtifacts();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /### Global search query stages per sample/);
  assert.match(result.stdout, /Query entered \(page ms\).*Debounce settled \(page ms\).*Matching search RPC returned \(page ms\).*Matching result visible \(page ms\)/);
  assert.match(result.stdout, /\| 1x \| base \| 1 \| 100\.0 \| 400\.0 \| 480\.0 \| 500\.0 \| 400\.0 \|/);
});

test('summary fails closed for a global-search sample with missing stage timestamps', () => {
  const result = runSummaryWithArtifacts({
    mutateReport: (report) => {
      report.variants.base['1x'].globalSearch[0].globalSearchStages.matchingSearchRpcReturnedAtMs = null;
    }
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /global search 1x base sample 1 has missing or invalid stage timestamps/);
});

test('summary fails closed when global-search time does not match its query stages', () => {
  const result = runSummaryWithArtifacts({
    mutateReport: (report) => {
      report.variants.head['100x'].globalSearch[0].ms -= 1;
    }
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /global search 100x head sample 1 has missing or invalid stage timestamps/);
});

test('summary lists RAF frame counts for every 100x scroll sample', () => {
  const result = runSummaryWithArtifacts();

  assert.equal(result.status, 0);
  assert.match(result.stdout, /### 100x scroll frame samples/);
  assert.match(result.stdout, /\| base \| 1 \| 100 \| 3 \| 2\.91% \|/);
  assert.doesNotMatch(result.stdout, /Presented frames|Presented drops|Presented drop/);
});
