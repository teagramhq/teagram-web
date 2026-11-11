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
const performanceFrameTrace = readFileSync(new URL('../../e2e/performanceFrameTrace.ts', import.meta.url), 'utf8');
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
  requireBase = true,
  eventName = 'pull_request'
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tweb-performance-summary-validation-'));
  const reportPath = join(directory, 'report.json');
  const recorderReplayPath = join(directory, 'recorder-replay.json');
  const historyDirectory = join(directory, 'history');
  const makeSample = (key) => ({
    ms: 100,
    ...(key === 'sendMessage' ? {appSendUiMs: 80} : {}),
    requests: 12,
    rpcCallCount: 2,
    domNodes: 300,
    bundleBytes: 100_000,
    longTasksOver50Ms: 0,
    blockingTimeMs: 0,
    maxLongTaskDurationMs: 0,
    ...(key === 'sendMessage' ? {appSendUiMs: 80} : {}),
    ...(key === 'scrollBack2k' ? {
      frameIntervals: 100,
      droppedFrames: 3,
      droppedFramePercent: 3 / 103 * 100,
      rafDropped: 3,
      presentedFrames: 98,
      presentedDropped: 1
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
        }]
      }
    },
    variants: {base, head}
  };
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

test('timing bundles enable only the cached-dialog probe and keep full profiles separate', () => {
  assert.match(workflow, /^\s+VITE_PERF_RECONCILE_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-head-dist"\s*$/m);
  assert.match(workflow, /^\s+\(cd "\$base_directory" && VITE_PERF_RECONCILE_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-base-dist"\)\s*$/m);
  assert.match(workflow, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-trace-dist"/);
  assert.doesNotMatch(workflow, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-(?:head|base)-dist"/);
});

test('gated scroll samples avoid screencast and CPU profiles', () => {
  const gatedScroll = performanceScale.match(/const scroll = await test\.step\('scroll back 2,000 messages'[\s\S]*?if\(!scroll\)/)?.[0];
  const diagnosticScroll = performanceScale.match(/const scrolled = await test\.step\(`profile 100x scroll back 2,000 messages[\s\S]*?if\(!scrolled/)?.[0];

  assert.ok(gatedScroll, 'the gated scroll scenario must be present');
  assert.doesNotMatch(gatedScroll, /Page\.startScreencast/);
  assert.match(gatedScroll, /pauseLongAnimationFrames: true/);
  assert.doesNotMatch(gatedScroll, /captureCpuStacks|captureFrameTrace|captureWorkerMessages|includeLongTaskTrace/);
  assert.ok(diagnosticScroll, 'the separate diagnostic scroll pass must be present');
  assert.match(diagnosticScroll, /captureCpuStacks: true/);
  assert.match(diagnosticScroll, /traceRpc: true/);
});

test('gated scroll samples trace compositor presentations beside RAF drops', () => {
  const gatedScroll = performanceScale.match(/const scroll = await test\.step\('scroll back 2,000 messages'[\s\S]*?if\(!scroll\)/)?.[0];
  const presentedFrameCapture = performanceFrameTrace.match(/export async function startPresentedFrameCapture[\s\S]*?(?=\nexport async function stopPresentedFrameCapture)/)?.[0];

  assert.ok(gatedScroll, 'the gated scroll scenario must be present');
  assert.ok(presentedFrameCapture, 'the compositor presentation capture must be present');
  assert.match(gatedScroll, /capturePresentedFrames: true/);
  assert.match(performanceScale, /presentedDropped/);
  assert.match(presentedFrameCapture, /categories: 'disabled-by-default-display\.framedisplayed,-\*'/);
  assert.doesNotMatch(presentedFrameCapture, /devtools\.timeline|blink\.user_timing|disabled-by-default-v8\.cpu_profiler/);
  assert.match(workflow, /e2e\/performancePresentedFrame\.spec\.ts/);
});

test('gated presented-frame trace draining overlaps later scenarios and finishes before context close', () => {
  const presentedFrameDrain = performanceFrameTrace.match(/export async function endPresentedFrameCapture[\s\S]*?(?=\nexport async function stopFrameTrace)/)?.[0];
  const scrollCapture = performanceScale.match(/async function scrollBackTwoThousand\([\s\S]*?(?=\nasync function )/)?.[0];
  const runVariant = performanceScale.match(/async function runVariant\([\s\S]*?(?=\nasync function traceDateJump)/)?.[0];

  assert.ok(presentedFrameDrain, 'the presented-frame trace must expose asynchronous drain completion');
  assert.match(presentedFrameDrain, /const captureResult = \(async\(\): Promise<.*> =>/);
  assert.match(presentedFrameDrain, /const result = captureResult\.then/);
  assert.match(presentedFrameDrain, /IO\.read', \{handle: stream, size: 1_048_576\}/);
  assert.match(scrollCapture, /endPresentedFrameCapture\(presentedFrameTrace\)/);
  assert.match(scrollCapture, /pendingPresentedFrameCountsKey/);
  assert.match(runVariant, /pendingPresentedFrameCounts = scroll\[pendingPresentedFrameCountsKey\]/);
  assert.match(runVariant, /await pendingPresentedFrameCounts/);
  assert.ok(runVariant.indexOf('await pendingPresentedFrameCounts') > runVariant.indexOf("test.step('send a message'"));
  assert.ok(runVariant.indexOf('await pendingPresentedFrameCounts') < runVariant.indexOf('await context.close()'));
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
  const buildStep = workflow.match(/- name: Build current and base private client bundles([\s\S]*?)(?=\n      - name: Start local HTTPS)/)?.[1];
  assert.ok(buildStep, 'the performance workflow must define its client build step');
  assert.match(buildStep, /cat \.github\/perf-sticker-base-commit/);
  assert.match(buildStep, /teagram-web-sticker-base-dist/);
  assert.equal(stickerBaseCommit, 'e28fb469fa0404c5ea396c0230d0c4c94bf20c5b');
  assert.match(stickerBaseCommit, /^[a-f0-9]{40}$/);
  assert.match(buildStep, /PERF_STICKER_BASE_ORIGIN=http:\/\/localhost:4179/);
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
  assert.match(performanceScale, /scrollBackTwoThousand\(\s*page,\s*requests,\s*true,/);
  assert.match(performanceScale, /jumpToFixtureDate\(page, requests, fixture, false, undefined, collectWalkDiagnostics\)/);
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

test('only pull requests build and require a base comparison', () => {
  assert.doesNotMatch(workflow, /workflow_dispatch:|performance_base_sha|github\.event\.inputs/);
  const checkoutStep = workflow.match(/- name: Check out web client([\s\S]*?)(?=\n      - name: Set performance output paths)/)?.[1];
  assert.ok(checkoutStep, 'the performance workflow must define its client checkout step');
  assert.doesNotMatch(checkoutStep, /^\s+ref:/m, 'the checkout must use the event head');
  assert.match(workflow, /PERF_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /PERF_REQUIRE_BASE: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('performance tracing uses a separate diagnostic bundle', () => {
  assert.match(workflow, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-trace-dist"/);
  assert.match(workflow, /PERF_TRACE_HEAD_ORIGIN_100X=http:\/\/localhost:4177/);
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

test('summary reports nine paired samples and keeps extra diagnostic samples out of the gate', () => {
  const scenarioKeys = ['coldChatList', 'warmChatList', 'chatOpen', 'scrollBack2k', 'dateJump', 'contactsList', 'contactSearch', 'globalSearch', 'sendMessage'];
  const makeSample = (ms) => ({
    ms,
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
    presentedFrames: 100,
    presentedDropped: 0,
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
          ...makeSample(100),
          ...(key === 'sendMessage' ? {appSendUiMs: 80} : {})
        }));
        variants[variant]['1x'][key] = samples();
        variants[variant]['100x'][key] = samples();
      }
    }
    variants.base['100x'].chatOpen = Array.from({length: PERFORMANCE_REPEATS}, () => makeSample(100));
    variants.head['100x'].chatOpen = timingSamples.map(makeSample);
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

test('summary lists RAF and compositor frame counts for every 100x scroll sample', () => {
  const result = runSummaryWithArtifacts();

  assert.equal(result.status, 0);
  assert.match(result.stdout, /### 100x scroll frame samples/);
  assert.match(result.stdout, /\| base \| 1 \| 100 \| 3 \| 98 \| 1 \| 2\.91% \|/);
  assert.match(result.stdout, /Presented frames/);
  assert.match(result.stdout, /Presented drops/);
});
