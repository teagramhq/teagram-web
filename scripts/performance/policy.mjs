export const SCENARIOS = [
  {key: 'coldChatList', label: 'Cold interactive chat list', budgetMs: 1_000},
  {key: 'warmChatList', label: 'Warm interactive chat list', budgetMs: 300},
  {key: 'chatOpen', label: 'Open long-history chat', budgetMs: 200},
  {key: 'scrollBack2k', label: 'Scroll back 2,000 messages', budgetMs: null},
  {key: 'dateJump', label: 'Jump to a date', budgetMs: null},
  {key: 'contactsList', label: 'Open contacts list', budgetMs: null},
  {key: 'contactSearch', label: 'Search contacts', budgetMs: null},
  {key: 'globalSearch', label: 'Global message search', budgetMs: null},
  {key: 'sendMessage', label: 'Send a message', budgetMs: null}
];

export const SCALES = ['1x', '100x'];
export const PERFORMANCE_MEASUREMENT_VERSION = 2;
export const PERFORMANCE_REPEATS = 3;

const CALIBRATION_RUNS = 20;
const MAX_SCALE_RATIO = 1.5;
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
  return Object.fromEntries(keys.map((key) => {
    const values = samples.map((sample) => sample[key]).filter(Number.isFinite);
    return [key, key === 'longTasksOver50Ms' && values.length ? Math.max(...values) : median(values)];
  }));
}

function matchesFixture(run, report) {
  return report.measurementVersion === PERFORMANCE_MEASUREMENT_VERSION &&
    run.measurementVersion === report.measurementVersion &&
    Boolean(report.fixtureVersion && report.serverCommit && report.fixtureServerCommit) &&
    run.fixtureVersion === report.fixtureVersion &&
    run.serverCommit === report.serverCommit &&
    run.fixtureServerCommit === report.fixtureServerCommit;
}

function historyFor(history, scale, key, report) {
  return history.flatMap((run) => {
    if(!matchesFixture(run, report)) return [];
    const samples = run.variants?.head?.[scale]?.[key];
    if(!Array.isArray(samples) || !samples.length) return [];
    const value = median(samples.map((sample) => sample.ms).filter(Number.isFinite));
    return Number.isFinite(value) ? [value] : [];
  });
}

function addFailure(failures, scale, key, message) {
  failures.push(`${scale} ${key}: ${message}`);
}

function timingNoise(mainValues) {
  const mainMedian = median(mainValues);
  return Math.max(mainMedian * 0.15, 3 * spread(mainValues));
}

function hasTimingRegression(headSamples, mainValues) {
  if(!headSamples.length || !mainValues.length) return false;
  const mainMedian = median(mainValues);
  const headMedian = median(headSamples.map((sample) => sample.ms).filter(Number.isFinite));
  if(!Number.isFinite(headMedian)) return false;
  const delta = headMedian - mainMedian;
  return delta > timingNoise(mainValues) && delta >= 2;
}

export function evaluatePerformance(report, history = []) {
  const rows = [];
  const blockingFailures = [];
  let calibratedScenarios = 0;

  for(const scale of SCALES) {
    for(const scenario of SCENARIOS) {
      const rawBaseSamples = report.variants?.base?.[scale]?.[scenario.key];
      const rawHeadSamples = report.variants?.head?.[scale]?.[scenario.key];
      const baseSamples = Array.isArray(rawBaseSamples) ? rawBaseSamples : [];
      const headSamples = Array.isArray(rawHeadSamples) ? rawHeadSamples : [];
      const base = summarizeSamples(baseSamples);
      const head = summarizeSamples(headSamples);
      const mainValues = historyFor(history, scale, scenario.key, report);
      const calibrated = mainValues.length >= CALIBRATION_RUNS;
      if(calibrated) ++calibratedScenarios;

      if(!headSamples.length) {
        addFailure(blockingFailures, scale, scenario.key, 'no head measurement was recorded');
      }
      if(headSamples.length < PERFORMANCE_REPEATS) {
        addFailure(blockingFailures, scale, scenario.key, `expected at least ${PERFORMANCE_REPEATS} repeat measurements, got ${headSamples.length}`);
      }
      headSamples.forEach((sample, index) => {
        const requiredMetrics = scenario.key === 'scrollBack2k' ? [...REQUIRED_METRICS, ['droppedFramePercent', 'dropped frame percentage']] : REQUIRED_METRICS;
        for(const [field, label] of requiredMetrics) {
          if(!Number.isFinite(sample?.[field])) {
            addFailure(blockingFailures, scale, scenario.key, `${label} is missing or invalid in head sample ${index + 1}`);
          }
        }
      });

      if(report.requireBase) {
        if(baseSamples.length < PERFORMANCE_REPEATS) {
          addFailure(blockingFailures, scale, scenario.key, `base bundle baseline requires ${PERFORMANCE_REPEATS} repeats, got ${baseSamples.length}`);
        }
        baseSamples.forEach((sample, index) => {
          if(!Number.isFinite(sample?.bundleBytes)) {
            addFailure(blockingFailures, scale, scenario.key, `base bundle measurement is missing or invalid in sample ${index + 1}`);
          }
        });
      }

      if(scale === '100x' && scenario.key === 'scrollBack2k' && Number.isFinite(head.longTasksOver50Ms) && head.longTasksOver50Ms > 0) {
        addFailure(blockingFailures, scale, scenario.key, `${head.longTasksOver50Ms} long task(s) over 50 ms`);
      }
      if(scale === '100x' && scenario.key === 'scrollBack2k' && Number.isFinite(head.droppedFramePercent) && head.droppedFramePercent >= 1) {
        addFailure(blockingFailures, scale, scenario.key, `dropped frames reached ${head.droppedFramePercent.toFixed(2)}%`);
      }

      if(report.requireBase && Number.isFinite(head.bundleBytes) && Number.isFinite(base.bundleBytes) && head.bundleBytes > base.bundleBytes * 1.02) {
        addFailure(blockingFailures, scale, scenario.key, `bundle grew from ${base.bundleBytes} to ${head.bundleBytes} bytes (over 2%)`);
      }

      const budgetMs = scale === '100x' ? scenario.budgetMs : null;
      const absoluteBudgetFailure = budgetMs !== null && Number.isFinite(head.ms) && head.ms > budgetMs;
      const relativeTimingFailure = hasTimingRegression(headSamples, mainValues);
      if(calibrated && absoluteBudgetFailure) {
        addFailure(blockingFailures, scale, scenario.key, `median timing ${head.ms} ms exceeded the ${budgetMs} ms budget`);
      } else if(calibrated && relativeTimingFailure) {
        addFailure(blockingFailures, scale, scenario.key, `median timing ${head.ms} ms regressed beyond the main noise band`);
      }

      const noiseWidth = calibrated ? timingNoise(mainValues) : undefined;
      const budgetStatus = calibrated && (absoluteBudgetFailure || relativeTimingFailure) ? 'failed' : calibrated ? 'calibrated' : 'warming';
      rows.push({
        ...scenario,
        scale,
        budgetMs,
        base,
        head,
        historyRuns: mainValues.length,
        noiseBand: calibrated ? [median(mainValues) - noiseWidth, median(mainValues) + noiseWidth] : undefined,
        budgetStatus
      });
    }
  }

  for(const scenario of SCENARIOS) {
    const small = rows.find((row) => row.scale === '1x' && row.key === scenario.key);
    const large = rows.find((row) => row.scale === '100x' && row.key === scenario.key);
    if(!small || !large || small.historyRuns < CALIBRATION_RUNS || large.historyRuns < CALIBRATION_RUNS) continue;
    if(!Number.isFinite(small.head.ms) || small.head.ms <= 0 || !Number.isFinite(large.head.ms)) continue;

    const ratio = large.head.ms / small.head.ms;
    large.scaleRatio = ratio;
    if(ratio > MAX_SCALE_RATIO) {
      addFailure(blockingFailures, '100x/1x', scenario.key, `median slowdown ${ratio.toFixed(2)}x exceeded ${MAX_SCALE_RATIO}x (${large.head.ms} ms / ${small.head.ms} ms)`);
      large.budgetStatus = 'failed';
    }
  }

  return {rows, blockingFailures, calibratedScenarios};
}

export function formatPerformanceTable(evaluation) {
  const lines = [
    '| Scenario | Head (ms) | Budget (ms) | Main noise band (ms) | 100x/1x | Base (ms) | Requests | DOM nodes | Long tasks >50 ms | Dropped frames | Bundle (bytes) | Gate |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for(const row of evaluation.rows) {
    const show = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
    const budget = row.budgetMs === null ? '—' : row.budgetMs;
    const noise = row.noiseBand ? `${show(row.noiseBand[0], 1)}–${show(row.noiseBand[1], 1)}` : `warming ${row.historyRuns}/${CALIBRATION_RUNS}`;
    const smallHistoryRuns = evaluation.rows.find((item) => item.scale === '1x' && item.key === row.key)?.historyRuns || 0;
    const ratio = row.scale !== '100x' ? '—' : Number.isFinite(row.scaleRatio) ? `${show(row.scaleRatio, 2)}x` : `warming ${Math.min(row.historyRuns, smallHistoryRuns)}/${CALIBRATION_RUNS}`;
    const gate = row.budgetStatus === 'failed' ? 'failed' : row.budgetStatus === 'warming' ? 'report only' : 'calibrated';
    lines.push(`| ${row.label} (${row.scale}) | ${show(row.head.ms, 1)} | ${budget} | ${noise} | ${ratio} | ${show(row.base.ms, 1)} | ${show(row.head.requests)} | ${show(row.head.domNodes)} | ${show(row.head.longTasksOver50Ms)} | ${show(row.head.droppedFramePercent, 2)}% | ${show(row.head.bundleBytes)} | ${gate} |`);
  }
  return lines.join('\n');
}

export const calibrationRunCount = CALIBRATION_RUNS;
