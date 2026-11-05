import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/performance.yml', import.meta.url), 'utf8');
const playwrightConfig = readFileSync(new URL('../../playwright.performance.config.ts', import.meta.url), 'utf8');

test('performance comparisons use uninstrumented head and base bundles', () => {
  assert.match(workflow, /^\s+pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-head-dist"\s*$/m);
  assert.match(workflow, /^\s+\(cd "\$base_directory" && pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-base-dist"\)\s*$/m);
});

test('performance tracing uses a separate diagnostic bundle', () => {
  assert.match(workflow, /VITE_PERF_TRACE=1 pnpm exec vite build --outDir "\$RUNNER_TEMP\/teagram-web-trace-dist"/);
  assert.match(workflow, /PERF_TRACE_HEAD_ORIGIN_100X=http:\/\/localhost:4177/);
  assert.match(workflow, /TG_WEBSOCKET_ALLOWED_ORIGINS=.*http:\/\/localhost:4177/);
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

test('extra timing samples are reported without changing the three-repeat policy verdict', () => {
  const scenarioKeys = ['coldChatList', 'warmChatList', 'chatOpen', 'scrollBack2k', 'dateJump', 'contactsList', 'contactSearch', 'globalSearch', 'sendMessage'];
  const makeSample = (ms) => ({
    ms,
    requests: 4,
    domNodes: 100,
    bundleBytes: 10_000,
    longTasksOver50Ms: 0,
    blockingTimeMs: 0,
    maxLongTaskDurationMs: 0,
    frameIntervals: 100,
    droppedFrames: 0,
    droppedFramePercent: 0
  });
  const makeReport = (timingSamples) => {
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
    return {
      measurementVersion: 2,
      fixtureVersion: 'fixture-v1',
      serverCommit: 'server-v1',
      fixtureServerCommit: 'fixture-server-v1',
      requireBase: true,
      variants
    };
  };
  const summaryFor = (timingSamples) => {
    const directory = mkdtempSync(join(tmpdir(), 'tweb-performance-summary-'));
    const reportPath = join(directory, 'report.json');
    const report = makeReport(timingSamples);
    const historyDirectory = join(directory, 'history');
    mkdirSync(historyDirectory);
    const historyVariants = JSON.parse(JSON.stringify(report.variants.head));
    historyVariants['100x'].chatOpen = Array.from({length: 3}, () => makeSample(100));
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
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_STEP_SUMMARY: ''
        }
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  };

  const threeSampleSummary = summaryFor([100, 100, 190]);
  const fiveSampleSummary = summaryFor([100, 100, 190, 900, 1_000]);
  const policySection = (summary) => summary.split('\n### 100x repeated scenario samples')[0];

  assert.equal(policySection(fiveSampleSummary), policySection(threeSampleSummary));
  assert.match(fiveSampleSummary, /Open long-history chat \| head \| 5 \| 1000\.0/);
});
