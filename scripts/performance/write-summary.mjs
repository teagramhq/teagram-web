import {mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {evaluatePairedDifferences, evaluatePerformance, formatPerformanceTable, formatPerformanceTraceTable, PAIRED_CONFIDENCE_LEVEL, PERFORMANCE_REPEATS, TIMING_MINIMUM_EFFECTS} from './policy.mjs';

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

function getHistoryServerRecords(sample) {
  if(!Array.isArray(sample?.serverRpcRecords)) return undefined;
  const records = sample.serverRpcRecords;
  if(!records.length || !records.every((record) => (
    record?.method === 'messages.getHistory' && Number.isSafeInteger(record.duration_us) && record.duration_us >= 0 &&
    typeof record.result === 'string' && record.result.length > 0 && Number.isSafeInteger(record.end_unix_ms) && record.end_unix_ms > 0
  ))) return undefined;
  return records;
}

function formatChatOpenServerTimingTable(report, failures) {
  const rows = [];
  const variants = report.requireBase ? ['base', 'head'] : ['head'];
  const show = (value) => Number.isFinite(value) ? value.toFixed(1) : 'n/a';
  const addRows = (source, variant, samples, diagnostic = false) => {
    if(!Array.isArray(samples) || !samples.length) {
      failures.push(`100x chatOpen ${source} ${variant} server timing samples are missing`);
      return;
    }
    for(const [index, sample] of samples.entries()) {
      const serverRecords = getHistoryServerRecords(sample);
      if(!serverRecords) {
        failures.push(`100x chatOpen ${source} ${variant} sample ${index + 1} has missing or invalid messages.getHistory server durations`);
        continue;
      }
      if(diagnostic) {
        const expectedCount = Array.isArray(sample.rpcCalls) ? sample.rpcCalls.filter((call) => call?.method === 'messages.getHistory').length : undefined;
        if(!Number.isInteger(expectedCount) || expectedCount !== serverRecords.length) {
          failures.push(`100x chatOpen RPC diagnostic ${variant} sample ${index + 1} has ${serverRecords.length} server records for ${expectedCount ?? 'unknown'} client messages.getHistory calls`);
          continue;
        }
        if(!Number.isFinite(sample.ms) || !Number.isFinite(sample.rpcWallMs) || !Number.isFinite(sample.nonRpcElapsedMs)) {
          failures.push(`100x chatOpen RPC diagnostic ${variant} sample ${index + 1} is missing total, RPC wall, or non-RPC timing`);
          continue;
        }
      }
      const serverDurations = serverRecords.map((record) => `${show(record.duration_us / 1000)} ms (${record.result})`).join(', ');
      const serverTotalMs = serverRecords.reduce((total, record) => total + record.duration_us / 1000, 0);
      const rpcResidual = diagnostic && Number.isFinite(sample.rpcWallMs) ? sample.rpcWallMs - serverTotalMs : undefined;
      rows.push(`| ${source} | ${variant} | ${index + 1} | ${show(sample.ms)} | ${show(sample.rpcWallMs)} | ${show(sample.nonRpcElapsedMs)} | ${serverDurations} | ${show(rpcResidual)} |`);
    }
  };

  for(const variant of variants) {
    addRows('gate sample', variant, report.variants?.[variant]?.['100x']?.chatOpen);
  }
  for(const variant of variants) {
    addRows('RPC diagnostic', variant, report.diagnostics?.['100x']?.rpcComparison?.[variant]?.chatOpen, true);
  }
  if(!rows.length) return '';
  return [
    '### 100x chat-open server handling',
    '',
    'Each server entry is one `messages.getHistory` handler duration. Gate samples preserve their existing timing boundary; RPC diagnostics also show the existing client RPC wall and non-RPC values.',
    '',
    '| Sample | Variant | Repeat | Time (ms) | RPC wall (ms) | Non-RPC (ms) | messages.getHistory server (ms each) | RPC wall minus server total (ms) |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |',
    ...rows
  ].join('\n');
}

function formatSendActionDiagnosticTable(report) {
  const sendSamples = report.diagnostics?.['100x']?.sendMessage;
  const sample = Array.isArray(sendSamples) ? sendSamples[0] : sendSamples;
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

function median(values) {
  if(!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sampleStandardDeviation(values) {
  if(values.length < 2) return 0;
  const center = values.reduce((total, value) => total + value, 0) / values.length;
  return Math.sqrt(values.reduce((total, value) => total + (value - center) ** 2, 0) / (values.length - 1));
}

function formatChatListMeasurementTable(report) {
  const scenarios = [
    ['coldChatList', 'Cold chat list'],
    ['warmChatList', 'Warm chat list']
  ];
  const rows = [];
  for(const [key, label] of scenarios) {
    for(const scale of ['1x', '100x']) {
      for(const variant of ['base', 'head']) {
        const samples = report.variants?.[variant]?.[scale]?.[key];
        if(!Array.isArray(samples) || !samples.length) continue;
        const values = (field, fallback) => samples.map((sample) => Number.isFinite(sample[field]) ? sample[field] : fallback(sample)).filter(Number.isFinite);
        const state = [...new Set(samples.map((sample) => sample.firstVisibleChatListSource).filter(Boolean))].join(', ') || 'unrecorded';
        rows.push({
          label,
          scale,
          variant,
          state,
          firstVisibleMs: median(values('firstVisibleChatListMs', (sample) => sample.ms)),
          liveBoundaryMs: median(values('liveBoundaryMs', (sample) => sample.ms)),
          requests: median(values('requests', () => undefined)),
          rpcCalls: median(values('rpcCallCount', () => undefined)),
          domNodes: median(values('domNodes', () => undefined)),
          longTasks: median(values('longTasksOver50Ms', () => undefined)),
          blockingTimeMs: median(values('blockingTimeMs', () => undefined)),
          bundleBytes: median(values('bundleBytes', () => undefined))
        });
      }
    }
  }
  if(!rows.length) return '';

  const show = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : '—';
  const lines = [
    '### Chat-list paint and counter boundaries',
    '',
    '| Scenario | Scale | Variant | First visible (ms) | First visible state | Live boundary (ms) | Requests | RPC calls | DOM nodes | Long tasks >50 ms | Blocking (ms) | Bundle bytes |',
    '| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];
  for(const row of rows) {
    lines.push(`| ${row.label} | ${row.scale} | ${row.variant} | ${show(row.firstVisibleMs, 1)} | ${row.state} | ${show(row.liveBoundaryMs, 1)} | ${show(row.requests)} | ${show(row.rpcCalls)} | ${show(row.domNodes)} | ${show(row.longTasks)} | ${show(row.blockingTimeMs, 1)} | ${show(row.bundleBytes)} |`);
  }
  return lines.join('\n');
}

function formatFirstStickerTable(diagnostics, requireBase, failures, reportOnlyFindings) {
  if(!diagnostics || !Number.isInteger(diagnostics.repeats) || diagnostics.repeats < 3 || (requireBase && diagnostics.repeats !== PERFORMANCE_REPEATS)) {
    const finding = `first sticker timing samples are missing or do not contain ${requireBase ? PERFORMANCE_REPEATS : 'at least 3'} cold repeats`;
    failures.push(finding);
    return '';
  }

  const variants = requireBase ? ['base', 'head', 'pinned'] : ['head'];
  const temperatures = ['cold', 'warm'];
  const lines = [
    '### First animated sticker frame',
    '',
    '| Variant | Worker | Repeats | Click to first frame (ms) | Click to visible frame (ms) |',
    '| --- | --- | ---: | ---: | ---: |'
  ];
  const show = (value) => Number.isFinite(value) ? value.toFixed(1) : 'n/a';

  for(const variant of variants) {
    for(const temperature of temperatures) {
      const samples = diagnostics.samples?.[variant]?.[temperature];
      const median = diagnostics.medians?.[variant]?.[temperature];
      const expectedRepeats = temperature === 'cold' && variant !== 'pinned' ? diagnostics.repeats : 3;
      if(variant === 'pinned' && temperature === 'warm' && (!Array.isArray(samples) || samples.length === 0)) continue;
      if(!Array.isArray(samples) || samples.length !== expectedRepeats || !samples.every((sample) => (
        Number.isFinite(sample?.clickToFirstFrameMs) && Number.isFinite(sample?.clickToVisibleFrameMs)
      )) || !Number.isFinite(median?.workerFrameMs) || !Number.isFinite(median?.visibleFrameMs)) {
        const finding = `first sticker ${variant} ${temperature} sample set is missing, invalid, or does not contain ${expectedRepeats} repeats`;
        failures.push(finding);
        continue;
      }
      lines.push(`| ${variant} | ${temperature} | ${samples.length} | ${show(median.workerFrameMs)} | ${show(median.visibleFrameMs)} |`);
    }
  }

  if(requireBase) {
    const baseSamples = diagnostics.samples?.base?.cold?.map((sample) => sample.clickToVisibleFrameMs);
    const headSamples = diagnostics.samples?.head?.cold?.map((sample) => sample.clickToVisibleFrameMs);
    if(Array.isArray(baseSamples) && Array.isArray(headSamples) && baseSamples.length === PERFORMANCE_REPEATS && headSamples.length === PERFORMANCE_REPEATS) {
      const differences = headSamples.map((value, index) => value - baseSamples[index]);
      const gate = evaluatePairedDifferences(differences, TIMING_MINIMUM_EFFECTS.firstStickerVisibleFrameMs);
      const status = gate.regression ? 'failed' : 'passed';
      lines.push('', `PR base/head cold visible-frame gate: paired SD ${show(sampleStandardDeviation(differences))} ms; one-sided ${Math.round(PAIRED_CONFIDENCE_LEVEL * 100)}% median lower bound ${show(gate.lowerBound)} ms; minimum effect ${TIMING_MINIMUM_EFFECTS.firstStickerVisibleFrameMs} ms; ${status}.`);
      if(gate.regression) {
        failures.push(`first sticker cold visible frame: one-sided ${Math.round(PAIRED_CONFIDENCE_LEVEL * 100)}% median lower bound ${show(gate.lowerBound)} ms exceeded minimum effect ${TIMING_MINIMUM_EFFECTS.firstStickerVisibleFrameMs} ms`);
      }
    } else {
      failures.push(`first sticker PR base/head comparison requires exactly ${PERFORMANCE_REPEATS} valid cold samples per variant`);
    }

    const pinnedMs = diagnostics.medians?.pinned?.cold?.visibleFrameMs;
    const headMs = diagnostics.medians?.head?.cold?.visibleFrameMs;
    if(Number.isFinite(pinnedMs) && Number.isFinite(headMs)) {
      const deltaMs = headMs - pinnedMs;
      const note = `Pinned pre-PR-178 cold visible-frame comparison: pinned ${show(pinnedMs)} ms, head ${show(headMs)} ms, increase ${show(deltaMs)} ms; report-only.`;
      lines.push(note);
      if(deltaMs > TIMING_MINIMUM_EFFECTS.firstStickerVisibleFrameMs) reportOnlyFindings.push(note);
    } else {
      failures.push('first sticker pinned-client comparison is missing a valid cold visible-frame median');
    }
  } else {
    lines.push('', 'Master timing is calibration only; the timing gate runs on pull requests with base/head samples.');
  }

  return lines.join('\n');
}

function formatWorkerRecorderTable(replay, requireBase, failures, reportOnlyFindings) {
  if(!replay || typeof replay !== 'object') {
    failures.push('worker recorder replay measurements are missing');
    return '';
  }

  const lines = [
    '### Worker recorder replay overhead',
    '',
    '| Workload | Record off (ms) | Record on (ms) | Overhead (ms) | Paired SD (ms) | 95% lower bound (ms) | Minimum effect (ms) | Iterations | Gate |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  const show = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
  for(const name of ['peers', 'dialogs']) {
    const measurement = replay[name];
    if(!measurement || !Number.isFinite(measurement.offMs) || measurement.offMs < 0 ||
      !Number.isFinite(measurement.onMs) || measurement.onMs < 0 ||
      !Number.isFinite(measurement.pairedDeltaMs) || !Number.isInteger(measurement.iterations) || measurement.iterations < 50 ||
      !Array.isArray(measurement.pairedDeltaSamples) || measurement.pairedDeltaSamples.length !== PERFORMANCE_REPEATS || !measurement.pairedDeltaSamples.every(Number.isFinite)) {
      const finding = `worker recorder ${name} sample set is missing, invalid, or shorter than 50 iterations`;
      failures.push(finding);
      continue;
    }
    if(Math.abs(measurement.pairedDeltaMs - median(measurement.pairedDeltaSamples)) > 0.000001) {
      const finding = `worker recorder ${name} paired delta median does not match its sample set`;
      failures.push(finding);
      continue;
    }
    const minimumEffect = Math.min(TIMING_MINIMUM_EFFECTS.workerRecorder.maximumMs, measurement.offMs * TIMING_MINIMUM_EFFECTS.workerRecorder.baseMedianFraction);
    const gate = evaluatePairedDifferences(measurement.pairedDeltaSamples, minimumEffect);
    const gateStatus = requireBase ? gate.regression ? 'failed' : 'passed' : 'calibration';
    const pairedSpread = sampleStandardDeviation(measurement.pairedDeltaSamples);
    lines.push(`| ${name} | ${show(measurement.offMs)} | ${show(measurement.onMs)} | ${show(measurement.pairedDeltaMs, 3)} | ${show(pairedSpread, 3)} | ${show(gate.lowerBound, 3)} | ${show(minimumEffect, 3)} | ${measurement.iterations} | ${gateStatus} |`);
    if(gate.regression) {
      const finding = `worker recorder ${name}: one-sided ${Math.round(PAIRED_CONFIDENCE_LEVEL * 100)}% median lower bound ${show(gate.lowerBound)} ms exceeded minimum effect ${show(minimumEffect)} ms`;
      if(requireBase) failures.push(finding);
      else reportOnlyFindings.push(finding);
    }
  }
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

let recorderReplay;
try {
  recorderReplay = readJson(resolve(process.env.PERF_RECORDER_REPLAY_PATH || '.performance-recorder-replay.json'));
} catch(error) {
  failures.push(`worker recorder replay report could not be read: ${error.message}`);
}

if(process.env.PERF_RECORDER_REPLAY_OUTCOME && process.env.PERF_RECORDER_REPLAY_OUTCOME !== 'success') {
  failures.push(`worker recorder replay did not succeed (${process.env.PERF_RECORDER_REPLAY_OUTCOME || 'not run'})`);
}

const evaluation = evaluatePerformance(policyReportWithMasterRepeatCount(report), history);
failures.push(...evaluation.blockingFailures);
if(process.env.PERF_BROWSER_OUTCOME !== 'success') {
  failures.push(`browser performance run did not succeed (${process.env.PERF_BROWSER_OUTCOME || 'not run'})`);
}

const table = formatPerformanceTable(evaluation);
const traceTable = formatPerformanceTraceTable(report.diagnostics?.['100x']);
const chatListMeasurementTable = formatChatListMeasurementTable(report);
const samplesTable = formatPerformanceSamplesTable(report);
const chatOpenServerTimingTable = formatChatOpenServerTimingTable(report, failures);
const sendActionDiagnosticTable = formatSendActionDiagnosticTable(report);
const reportOnlyFindings = [...evaluation.reportOnlyFailures];
const firstStickerTable = formatFirstStickerTable(report.diagnostics?.firstSticker, report.requireBase, failures, reportOnlyFindings);
const workerRecorderTable = formatWorkerRecorderTable(recorderReplay, report.requireBase, failures, reportOnlyFindings);
const summary = [
  '## Web performance at scale',
  '',
  `Fixture: \`${report.fixtureVersion || 'not recorded'}\`; server runtime commit: \`${report.serverCommit || 'not recorded'}\`; fixture seed commit: \`${report.fixtureServerCommit || 'not recorded'}\`.`,
  '',
  table,
  ...(traceTable ? ['', traceTable] : []),
  ...(chatListMeasurementTable ? ['', chatListMeasurementTable] : []),
  ...(samplesTable ? ['', samplesTable] : []),
  ...(chatOpenServerTimingTable ? ['', chatOpenServerTimingTable] : []),
  ...(sendActionDiagnosticTable ? ['', sendActionDiagnosticTable] : []),
  ...(firstStickerTable ? ['', firstStickerTable] : []),
  ...(workerRecorderTable ? ['', workerRecorderTable] : []),
  '',
  `Pull-request timing gates use interleaved base/head pairs and a one-sided ${Math.round(PAIRED_CONFIDENCE_LEVEL * 100)}% distribution-free lower confidence bound for the median. Master timing history is report-only calibration.`,
  '',
  '### Timing calibration and pinned-baseline findings',
  '',
  reportOnlyFindings.length ? reportOnlyFindings.map((finding) => `- ${finding}`).join('\n') : 'No calibration or pinned-baseline findings.',
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
