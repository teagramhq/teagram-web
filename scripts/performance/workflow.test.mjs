import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/performance.yml', import.meta.url), 'utf8');
const playwrightConfig = readFileSync(new URL('../../playwright.performance.config.ts', import.meta.url), 'utf8');
const performanceScale = readFileSync(new URL('../../e2e/performanceScale.spec.ts', import.meta.url), 'utf8');
const chatPageSnapshotView = readFileSync(new URL('../../src/lib/chatPageSnapshotView.ts', import.meta.url), 'utf8');
const stickerBaseCommit = readFileSync(new URL('../../.github/perf-sticker-base-commit', import.meta.url), 'utf8').trim();

test('performance comparisons use uninstrumented head and base bundles', () => {
  assert.match(workflow, /^\s+pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-head-dist"\s*$/m);
  assert.match(workflow, /^\s+\(cd "\$base_directory" && pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-base-dist"\)\s*$/m);
  assert.doesNotMatch(workflow, /VITE_PERF_(?:RECONCILE_)?TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-(?:head|base)-dist"/);
});

test('sticker timing uses the pre-178 baseline independently from the scale base', () => {
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
  assert.match(performanceScale, /firstStickerBaseRun/);
  assert.match(performanceScale, /expect\(firstVisibleChatList\.source\)\.toBe\('snapshot'\)/);
  assert.doesNotMatch(performanceScale, /firstVisibleChatList\.source\)\.toBe\((?:run\.)?variant === 'head'/);
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

test('measured head scroll attribution is recorded without a validity gate', () => {
  assert.match(performanceScale, /const headScrollRepeats = report\.variants\.head\['100x'\]\.scrollBack2k;/);
  assert.match(performanceScale, /metric\.longTaskTraceStatus = classifyMeasuredLongTaskTrace\(metric\)/);
  assert.doesNotMatch(performanceScale, /validateMeasuredLongTaskTraces\(/);
});

test('extra timing samples are reported without changing the three-repeat policy verdict', () => {
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
    composerReadyAfterFirstBubbleMs: 50,
    firstBubbleToSentMs: ms + 50
  });
  const makeReport = (timingSamples, sendSamples) => {
    const variants = {};
    for(const variant of ['base', 'head']) {
      variants[variant] = {'1x': {}, '100x': {}};
      for(const key of scenarioKeys) {
        const count = key === 'coldChatList' ? 6 : 3;
        variants[variant]['1x'][key] = Array.from({length: count}, () => makeSample(100));
        variants[variant]['100x'][key] = Array.from({length: count}, () => makeSample(100));
      }
    }
    variants.base['100x'].chatOpen = Array.from({length: 3}, () => makeSample(100));
    variants.head['100x'].chatOpen = timingSamples.map(makeSample);
    variants.base['100x'].sendMessage = sendSamples.base.map((ms) => ({...makeSample(ms), appSendUiMs: ms - 20}));
    variants.head['100x'].sendMessage = sendSamples.head.map((ms) => ({...makeSample(ms), appSendUiMs: ms - 20}));
    return {
      measurementVersion: 2,
      fixtureVersion: 'fixture-v1',
      serverCommit: 'server-v1',
      fixtureServerCommit: 'fixture-server-v1',
      requireBase: true,
      diagnostics: {
        '100x': {
          sendMessage: [{
            ms: 123,
            appSendUiMs: 101,
            requests: 0,
            domNodes: 1_000,
            domNodeCounts: {bubbleGroups: 12},
            longTasksOver50Ms: 0,
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
  const summaryFor = (timingSamples, sendSamples = {base: [100, 100, 100], head: [100, 100, 100]}, eventName = 'pull_request') => {
    const directory = mkdtempSync(join(tmpdir(), 'tweb-performance-summary-'));
    const reportPath = join(directory, 'report.json');
    const report = makeReport(timingSamples, sendSamples);
    const historyDirectory = join(directory, 'history');
    mkdirSync(historyDirectory);
    const historyVariants = JSON.parse(JSON.stringify(report.variants.head));
    historyVariants['100x'].chatOpen = Array.from({length: 3}, () => makeSample(100));
    historyVariants['100x'].sendMessage = historyVariants['100x'].sendMessage.slice(0, 3);
    writeFileSync(reportPath, JSON.stringify(report));
    for(let index = 0; index < 20; ++index) {
      writeFileSync(join(historyDirectory, `history-${index}.json`), JSON.stringify({
        measurementVersion: 2,
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
        assert.equal(savedHistory.variants.base['100x'].sendMessage.length, 3);
        assert.equal(savedHistory.variants.head['100x'].sendMessage.length, 3);
      }
      return result.stdout;
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  };

  const threeSampleSummary = summaryFor([100, 100, 190]);
  const fiveSampleSummary = summaryFor([100, 100, 190, 900, 1_000]);
  const elevenSendSampleSummary = summaryFor([100, 100, 190], {
    base: [100, 100, 100, 200, 300, 400, 500, 600, 700, 800, 900],
    head: [100, 100, 100, 200, 300, 400, 500, 600, 700, 800, 1_100]
  }, 'push');
  const policySection = (summary) => summary.split('\n### 100x repeated scenario samples')[0];

  assert.equal(policySection(fiveSampleSummary), policySection(threeSampleSummary));
  assert.equal(policySection(elevenSendSampleSummary), policySection(threeSampleSummary));
  assert.match(fiveSampleSummary, /Open long-history chat \| head \| 5 \| 1000\.0/);
  assert.match(elevenSendSampleSummary, /Send a message \| head \| 11 \| 1100\.0 \| 1080\.0 \| 50\.0 \| 1150\.0/);
  assert.match(threeSampleSummary, /100x send action diagnostic/);
  assert.match(threeSampleSummary, /### Chat-list paint and counter boundaries/);
  assert.match(threeSampleSummary, /\| Scenario \| Scale \| Variant \| First visible \(ms\) \| First visible state \| Live boundary \(ms\) \| Requests \| RPC calls \| DOM nodes \| Long tasks >50 ms \| Blocking \(ms\) \| Bundle bytes \|/);
  assert.match(threeSampleSummary, /\| Cold chat list \| 1x \| head \| 100\.0 \| snapshot \| 500\.0 \| 4 \| 2 \| 100 \| 0 \| 0\.0 \| 10000 \|/);
  assert.match(threeSampleSummary, /\| 123\.0 \| 101\.0 \| 1 \| 81\.0 \| 42\.0 \| 0 \| 1000 \| 12 \| 0 \| 0\.0 \| messages\.sendMessage \(81\.0 ms, success\) \| sendMessage \/input\.ts \(22\.0 ms\) \|/);
});
