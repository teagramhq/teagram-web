export const SCENARIOS = [
  {key: 'coldChatList', label: 'Cold interactive chat list', budgetMs: 1_000},
  {key: 'warmChatList', label: 'Warm interactive chat list', budgetMs: 300},
  {key: 'chatOpen', label: 'Open the million-message chat', budgetMs: 200},
  {key: 'scrollBack2k', label: 'Scroll back 2,000 messages', budgetMs: null},
  {key: 'dateJump', label: 'Jump to a date', budgetMs: null},
  {key: 'contactsList', label: 'Open 10,000-contact list', budgetMs: null},
  {key: 'contactSearch', label: 'Search contacts', budgetMs: null},
  {key: 'globalSearch', label: 'Global message search', budgetMs: null},
  {key: 'sendMessage', label: 'Send a message', budgetMs: null}
];

const CALIBRATION_RUNS = 20;
const REQUIRED_METRICS = [
  ['ms', 'timing'],
  ['requests', 'requests'],
  ['domNodes', 'DOM nodes'],
  ['bundleBytes', 'bundle bytes'],
  ['longTasksOver50Ms', 'long task counter']
];

function median(values) {
  if(!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function spread(values) {
  if(!values.length) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function summarizeSamples(samples = []) {
  const keys = ['ms', 'requests', 'domNodes', 'bundleBytes', 'longTasksOver50Ms', 'droppedFramePercent'];
  return Object.fromEntries(keys.map((key) => [key, median(samples.map((sample) => sample[key]).filter(Number.isFinite))]));
}

function historyFor(history, key) {
  return history.flatMap((run) => {
    const samples = run.variants?.head?.[key];
    if(!Array.isArray(samples) || !samples.length) return [];
    const value = median(samples.map((sample) => sample.ms).filter(Number.isFinite));
    return Number.isFinite(value) ? [value] : [];
  });
}

function addFailure(failures, key, message) {
  failures.push(`${key}: ${message}`);
}

function timingFailureForSample(sample, scenario, mainValues) {
  const budgetFailed = scenario.budgetMs !== null && sample.ms > scenario.budgetMs;
  if(!mainValues.length) return budgetFailed;

  const mainMedian = median(mainValues);
  const threshold = Math.max(mainMedian * 0.15, 3 * spread(mainValues));
  const regressed = sample.ms - mainMedian > threshold && sample.ms - mainMedian >= 2;
  return budgetFailed || regressed;
}

export function evaluatePerformance(report, history = []) {
  const rows = [];
  const blockingFailures = [];
  let calibratedScenarios = 0;

  for(const scenario of SCENARIOS) {
    const rawBaseSamples = report.variants?.base?.[scenario.key];
    const rawHeadSamples = report.variants?.head?.[scenario.key];
    const baseSamples = Array.isArray(rawBaseSamples) ? rawBaseSamples : [];
    const headSamples = Array.isArray(rawHeadSamples) ? rawHeadSamples : [];
    const base = summarizeSamples(baseSamples);
    const head = summarizeSamples(headSamples);
    const mainValues = historyFor(history, scenario.key);
    const calibrated = mainValues.length >= CALIBRATION_RUNS;
    if(calibrated) ++calibratedScenarios;

    if(!headSamples.length) {
      addFailure(blockingFailures, scenario.key, 'no head measurement was recorded');
    }
    if(headSamples.length < 2) {
      addFailure(blockingFailures, scenario.key, `expected at least two repeat measurements, got ${headSamples.length}`);
    }
    headSamples.forEach((sample, index) => {
      const requiredMetrics = scenario.key === 'scrollBack2k' ? [...REQUIRED_METRICS, ['droppedFramePercent', 'dropped frame percentage']] : REQUIRED_METRICS;
      for(const [field, label] of requiredMetrics) {
        if(!Number.isFinite(sample?.[field])) {
          addFailure(blockingFailures, scenario.key, `${label} is missing or invalid in sample ${index + 1}`);
        }
      }
    });

    if(scenario.key === 'scrollBack2k' && Number.isFinite(head.longTasksOver50Ms) && head.longTasksOver50Ms > 0) {
      addFailure(blockingFailures, scenario.key, `${head.longTasksOver50Ms} long task(s) over 50 ms`);
    }
    if(scenario.key === 'scrollBack2k' && Number.isFinite(head.droppedFramePercent) && head.droppedFramePercent >= 1) {
      addFailure(blockingFailures, scenario.key, `dropped frames reached ${head.droppedFramePercent.toFixed(2)}%`);
    }

    if(baseSamples.length) {
      if(Number.isFinite(head.bundleBytes) && Number.isFinite(base.bundleBytes) && head.bundleBytes > base.bundleBytes * 1.02) {
        addFailure(blockingFailures, scenario.key, `bundle grew from ${base.bundleBytes} to ${head.bundleBytes} bytes (over 2%)`);
      }
    }

    const repeatedTimingFailure = headSamples.length >= 2 && headSamples.every((sample) => {
      return Number.isFinite(sample.ms) && timingFailureForSample(sample, scenario, mainValues);
    });
    const absoluteBudgetFailure = scenario.budgetMs !== null && Number.isFinite(head.ms) && head.ms > scenario.budgetMs;
    if(calibrated && absoluteBudgetFailure) {
      addFailure(blockingFailures, scenario.key, `median timing ${head.ms} ms exceeded the ${scenario.budgetMs} ms budget`);
    } else if(calibrated && repeatedTimingFailure) {
      const budget = scenario.budgetMs === null ? '' : `; budget ${scenario.budgetMs} ms`;
      addFailure(blockingFailures, scenario.key, `timing regression repeated twice (${head.ms} ms${budget})`);
    }

    const noiseWidth = mainValues.length ? Math.max(median(mainValues) * 0.15, 3 * spread(mainValues)) : undefined;
    const budgetStatus = calibrated && (absoluteBudgetFailure || repeatedTimingFailure) ? 'failed' : calibrated ? 'calibrated' : 'warming';
    rows.push({
      ...scenario,
      base,
      head,
      historyRuns: mainValues.length,
      noiseBand: calibrated ? [median(mainValues) - noiseWidth, median(mainValues) + noiseWidth] : undefined,
      budgetStatus
    });
  }

  return {rows, blockingFailures, calibratedScenarios};
}

export function formatPerformanceTable(evaluation) {
  const lines = [
    '| Scenario | Head (ms) | Budget (ms) | Main noise band (ms) | Base (ms) | Requests | DOM nodes | Long tasks >50 ms | Dropped frames | Bundle (bytes) | Gate |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for(const row of evaluation.rows) {
    const show = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
    const budget = row.budgetMs === null ? '—' : row.budgetMs;
    const noise = row.noiseBand ? `${show(row.noiseBand[0], 1)}–${show(row.noiseBand[1], 1)}` : `warming ${row.historyRuns}/${CALIBRATION_RUNS}`;
    const gate = row.budgetStatus === 'failed' ? 'failed' : row.budgetStatus === 'warming' ? 'report only' : 'calibrated';
    lines.push(`| ${row.label} | ${show(row.head.ms, 1)} | ${budget} | ${noise} | ${show(row.base.ms, 1)} | ${show(row.head.requests)} | ${show(row.head.domNodes)} | ${show(row.head.longTasksOver50Ms)} | ${show(row.head.droppedFramePercent, 2)}% | ${show(row.head.bundleBytes)} | ${gate} |`);
  }
  return lines.join('\n');
}

export const calibrationRunCount = CALIBRATION_RUNS;
