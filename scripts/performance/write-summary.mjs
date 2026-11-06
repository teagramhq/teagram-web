import {mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {evaluatePerformance, formatPerformanceTable, formatPerformanceTraceTable, PERFORMANCE_REPEATS} from './policy.mjs';

const reportPath = resolve(process.env.PERF_REPORT_PATH || '.performance-report.json');
const historyDirectory = resolve(process.env.PERF_HISTORY_DIRECTORY || '.performance-history');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const timingSampleScenarios = ['chatOpen', 'scrollBack2k', 'sendMessage'];
function policyReportWithMasterRepeatCount(source) {
  const report = structuredClone(source);
  for(const variant of Object.values(report.variants || {})) {
    for(const scenario of timingSampleScenarios) {
      const samples = variant?.['100x']?.[scenario];
      if(Array.isArray(samples)) {
        variant['100x'][scenario] = samples.slice(0, PERFORMANCE_REPEATS);
      }
    }
  }
  return report;
}

function formatPerformanceSamplesTable(report, scale = '100x') {
  const scenarios = [
    ['chatOpen', 'Open long-history chat'],
    ['scrollBack2k', 'Scroll back 2,000 messages'],
    ['sendMessage', 'Send a message']
  ];
  const rows = [];
  for(const [key, label] of scenarios) {
    for(const variant of ['base', 'head']) {
      const samples = report.variants?.[variant]?.[scale]?.[key];
      if(!Array.isArray(samples)) continue;
      samples.forEach((sample, index) => rows.push({label, variant, index, sample}));
    }
  }
  if(!rows.length) return '';

  const show = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
  const lines = [
    `### ${scale} repeated scenario samples`,
    '',
    '| Scenario | Variant | Repeat | Time (ms) | App Enter-to-bubble (ms) | Composer ready after first bubble (ms) | First bubble to sent (ms) | preInteractionMs | Requests | DOM nodes | Long tasks >50 ms | Blocking (ms) | Dropped frames |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];
  for(const {label, variant, index, sample} of rows) {
    lines.push(`| ${label} | ${variant} | ${index + 1} | ${show(sample.ms)} | ${show(sample.appSendUiMs)} | ${show(sample.composerReadyAfterFirstBubbleMs)} | ${show(sample.firstBubbleToSentMs)} | ${show(sample.preInteractionMs)} | ${show(sample.requests, 0)} | ${show(sample.domNodes, 0)} | ${show(sample.longTasksOver50Ms, 0)} | ${show(sample.blockingTimeMs)} | ${show(sample.droppedFramePercent)}% |`);
  }
  lines.push('', 'For send rows, `Time` is the automation-observed interval and `App Enter-to-bubble` measures in-page time from Enter keydown to the matching outgoing bubble insertion.');
  return lines.join('\n');
}

function formatSendActionDiagnosticTable(report) {
  const sample = report.diagnostics?.['100x']?.sendMessage;
  if(!sample) return '';

  const show = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
  const rpcCalls = (sample.rpcCalls || []).map((call) => `${call.method} (${show(call.durationMs)} ms, ${call.outcome})`).join(', ') || '—';
  const cpuFrames = (sample.cpu?.topFrames || []).slice(0, 5).map((frame) => `${frame.functionName} ${frame.script} (${show(frame.selfMs)} ms)`).join(', ') || '—';
  const lines = [
    '### 100x send action diagnostic',
    '',
    '| Automation action (ms) | App Enter-to-bubble (ms) | RPC calls | RPC wall (ms) | Non-RPC (ms) | Requests | DOM nodes | Bubble groups | Long tasks >50 ms | Blocking (ms) | RPC methods | Top CPU frames |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    `| ${show(sample.ms)} | ${show(sample.appSendUiMs)} | ${show(sample.rpcCallCount, 0)} | ${show(sample.rpcWallMs)} | ${show(sample.nonRpcElapsedMs)} | ${show(sample.requests, 0)} | ${show(sample.domNodes, 0)} | ${show(sample.domNodeCounts?.bubbleGroups, 0)} | ${show(sample.longTasksOver50Ms, 0)} | ${show(sample.blockingTimeMs)} | ${rpcCalls} | ${cpuFrames} |`
  ];
  return lines.join('\n');
}

let report = {variants: {}};
const failures = [];

try {
  report = readJson(reportPath);
} catch(error) {
  failures.push(`browser report could not be read: ${error.message}`);
}

const history = [];
try {
  for(const filename of readdirSync(historyDirectory).filter((name) => name.endsWith('.json')).sort()) {
    try {
      history.push(readJson(join(historyDirectory, filename)));
    } catch(error) {
      failures.push(`history file ${filename} is invalid: ${error.message}`);
    }
  }
} catch(error) {
  if(error.code !== 'ENOENT') failures.push(`history could not be read: ${error.message}`);
}

const evaluation = evaluatePerformance(policyReportWithMasterRepeatCount(report), history);
failures.push(...evaluation.blockingFailures);
if(process.env.PERF_BROWSER_OUTCOME !== 'success') {
  failures.push(`browser performance run did not succeed (${process.env.PERF_BROWSER_OUTCOME || 'not run'})`);
}

const table = formatPerformanceTable(evaluation);
const traceTable = formatPerformanceTraceTable(report.diagnostics?.['100x']);
const samplesTable = formatPerformanceSamplesTable(report);
const sendActionDiagnosticTable = formatSendActionDiagnosticTable(report);
const summary = [
  '## Web performance at scale',
  '',
  `Fixture: \`${report.fixtureVersion || 'not recorded'}\`; server runtime commit: \`${report.serverCommit || 'not recorded'}\`; fixture seed commit: \`${report.fixtureServerCommit || 'not recorded'}\`.`,
  '',
  table,
  ...(traceTable ? ['', traceTable] : []),
  ...(samplesTable ? ['', samplesTable] : []),
  ...(sendActionDiagnosticTable ? ['', sendActionDiagnosticTable] : []),
  '',
  evaluation.calibratedScenarios === 0 ? 'Timing budgets and the 100x/1x slowdown ceiling are report-only until each scale and scenario has 20 compatible successful master runs; over-budget 100x rows are marked in the table. PR artifacts collect five paired samples for 100x chat open and scroll back, plus eleven paired send samples; the existing three-sample policy and calibration version are unchanged, and extra timing samples are report-only. Send and scroll timing add no timing gates. After 20 compatible successful master runs, 100x scroll task counts and dropped-frame repeats beyond their noise bands block; scroll blocking-time deltas must also exceed the noise band by at least 80 ms. Pull requests require complete base bundle measurements; 100x non-scroll long-task count regressions and blocking-time increases of at least 80 ms, bundle growth and the 200 ms control block immediately.' : `Timing calibration is active for ${evaluation.calibratedScenarios} scale/scenario row(s); timing checks are report-only for uncalibrated rows and mark absolute budget misses until each reaches 20 compatible successful master runs. PR artifacts collect five paired samples for 100x chat open and scroll back, plus eleven paired send samples; the existing three-sample policy and calibration version are unchanged, and extra timing samples are report-only. Send and scroll timing add no timing gates. After 20 compatible successful master runs, 100x scroll task counts and dropped-frame repeats beyond their noise bands block; scroll blocking-time deltas must also exceed the noise band by at least 80 ms. Pull requests require complete base bundle measurements; 100x non-scroll long-task count regressions and blocking-time increases of at least 80 ms, bundle growth and the 200 ms control block immediately.`,
  failures.length ? `\nBlocking findings:\n${failures.map((failure) => `- ${failure}`).join('\n')}` : '\nNo blocking performance findings.'
].join('\n');

if(process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, {flag: 'a'});
else process.stdout.write(`${summary}\n`);

if(
  process.env.GITHUB_EVENT_NAME === 'push' &&
  process.env.GITHUB_REF === 'refs/heads/master' &&
  failures.length === 0
) {
  mkdirSync(historyDirectory, {recursive: true});
  const historyPath = join(historyDirectory, `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.json`);
  writeFileSync(historyPath, `${JSON.stringify({...policyReportWithMasterRepeatCount(report), recordedAt: new Date().toISOString()}, null, 2)}\n`);
  const files = readdirSync(historyDirectory).filter((name) => name.endsWith('.json')).sort();
  for(const oldFile of files.slice(0, Math.max(0, files.length - 20))) {
    unlinkSync(join(historyDirectory, oldFile));
  }
}

if(failures.length) {
  process.stderr.write(`${failures.map((failure) => `::error::${failure}`).join('\n')}\n`);
  process.exitCode = 1;
}
