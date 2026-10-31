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
// Cold-load pairs need additional samples to outvote occasional runner long tasks.
export const COLD_CHAT_LIST_REPEATS = 6;

export function scenarioBundleBytes(resources, origin, startedAt) {
  const bundleResources = new Map();
  resources.filter((entry) => {
    return entry.startTime >= startedAt &&
      new URL(entry.name).origin === origin &&
      /\.(js|css)(?:[?#]|$)/i.test(entry.name);
  }).forEach((entry) => bundleResources.set(entry.name, entry.decodedBodySize));
  return [...bundleResources.values()].reduce((total, bytes) => total + bytes, 0);
}

const CALIBRATION_RUNS = 20;
const MAX_SCALE_RATIO = 1.5;
const MIN_BLOCKING_TIME_REGRESSION_MS = 80;
// A 100 ms task adds 50 ms of blocking time to every repeat.
const MIN_SEPARATED_BLOCKING_TIME_REGRESSION_MS = 40;
const REQUIRED_METRICS = [
  ['ms', 'timing'],
  ['requests', 'requests'],
  ['domNodes', 'DOM nodes'],
  ['bundleBytes', 'bundle bytes'],
  ['longTasksOver50Ms', 'long task counter'],
  ['blockingTimeMs', 'long-task blocking time'],
  ['maxLongTaskDurationMs', 'maximum long task duration']
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
  const keys = ['ms', 'requests', 'domNodes', 'bundleBytes', 'longTasksOver50Ms', 'blockingTimeMs', 'droppedFramePercent'];
  const summary = Object.fromEntries(keys.map((key) => {
    const values = samples.map((sample) => sample[key]).filter(Number.isFinite);
    return [key, key === 'longTasksOver50Ms' && values.length ? Math.max(...values) : median(values)];
  }));
  const frameIntervals = samples.reduce((total, sample) => total + (Number.isFinite(sample?.frameIntervals) ? sample.frameIntervals : 0), 0);
  const droppedFrames = samples.reduce((total, sample) => total + (Number.isFinite(sample?.droppedFrames) ? sample.droppedFrames : 0), 0);
  const totalFrames = frameIntervals + droppedFrames;
  if(totalFrames > 0) summary.droppedFramePercent = droppedFrames / totalFrames * 100;
  return summary;
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

function medianLongTasks(samples) {
  if(!Array.isArray(samples) || !samples.length) return undefined;
  return median(samples.map((sample) => Number.isFinite(sample?.longTasksOver50Ms) ? sample.longTasksOver50Ms : 0));
}

// Same-run base repeats on the hosted runner swing by whole long tasks and over 100 ms of blocking time,
// so non-cold-load regressions must separate from every base repeat.
function separatedRegression(headSamples, baseSamples, field, minMedianIncrease = 0) {
  const headValues = headSamples.map((sample) => sample?.[field]);
  const baseValues = baseSamples.map((sample) => sample?.[field]);
  if(!headValues.length || !baseValues.length || ![...headValues, ...baseValues].every(Number.isFinite)) return false;
  return Math.min(...headValues) > Math.max(...baseValues) && median(headValues) - median(baseValues) >= minMedianIncrease;
}

function medianPairedDifference(headSamples, baseSamples, field) {
  if(!headSamples.length || headSamples.length !== baseSamples.length) return undefined;
  const differences = headSamples.map((sample, index) => sample?.[field] - baseSamples[index]?.[field]);
  return differences.every(Number.isFinite) ? median(differences) : undefined;
}

function medianMetric(samples, field) {
  if(!Array.isArray(samples) || !samples.length) return undefined;
  const values = samples.map((sample) => sample?.[field]);
  return values.every(Number.isFinite) ? median(values) : undefined;
}

function medianBlockingTime(samples) {
  return medianMetric(samples, 'blockingTimeMs');
}

function historyLongTaskBaseline(history, scale, key, report) {
  const counts = history.flatMap((run) => {
    if(!matchesFixture(run, report)) return [];
    const count = medianLongTasks(run.variants?.head?.[scale]?.[key]);
    return Number.isFinite(count) ? [count] : [];
  });
  return median(counts);
}

function historyBlockingTimeBaseline(history, scale, key, report) {
  const blockingTimes = history.flatMap((run) => {
    if(!matchesFixture(run, report)) return [];
    const value = medianBlockingTime(run.variants?.head?.[scale]?.[key]);
    return Number.isFinite(value) ? [value] : [];
  });
  return median(blockingTimes);
}

function addFailure(failures, scale, key, message) {
  failures.push(`${scale} ${key}: ${message}`);
}

function historyScrollMetrics(history, report) {
  return history.flatMap((run) => {
    if(!matchesFixture(run, report)) return [];
    const samples = run.variants?.head?.['100x']?.scrollBack2k;
    if(!Array.isArray(samples) || samples.length < PERFORMANCE_REPEATS) return [];
    const complete = samples.every((sample) => {
      return Number.isFinite(sample?.longTasksOver50Ms) &&
        Number.isFinite(sample?.blockingTimeMs) &&
        Number.isFinite(sample?.frameIntervals) && sample.frameIntervals > 0 &&
        Number.isFinite(sample?.droppedFrames) && sample.droppedFrames >= 0 &&
        Number.isFinite(sample?.droppedFramePercent);
    });
    if(!complete) return [];
    const metrics = {
      longTasksOver50Ms: medianMetric(samples, 'longTasksOver50Ms'),
      blockingTimeMs: medianBlockingTime(samples),
      droppedFramePercent: summarizeSamples(samples).droppedFramePercent
    };
    return Object.values(metrics).every(Number.isFinite) ? [metrics] : [];
  });
}

function timingNoise(mainValues) {
  const mainMedian = median(mainValues);
  return Math.max(mainMedian * 0.15, 3 * spread(mainValues));
}

function metricNoiseBand(values) {
  const center = median(values);
  const width = timingNoise(values);
  return [center - width, center + width];
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
      const requiredRepeats = scale === '100x' && scenario.key === 'coldChatList' ? COLD_CHAT_LIST_REPEATS : PERFORMANCE_REPEATS;
      const mainValues = historyFor(history, scale, scenario.key, report);
      const calibrated = mainValues.length >= CALIBRATION_RUNS;
      const scrollHistory = scale === '100x' && scenario.key === 'scrollBack2k' ? historyScrollMetrics(history, report) : [];
      const scrollHistoryRuns = scrollHistory.length;
      const scrollCalibrated = scrollHistoryRuns >= CALIBRATION_RUNS;
      const scrollNoiseBands = scrollCalibrated ? {
        longTasksOver50Ms: metricNoiseBand(scrollHistory.map((run) => run.longTasksOver50Ms)),
        blockingTimeMs: metricNoiseBand(scrollHistory.map((run) => run.blockingTimeMs)),
        droppedFramePercent: metricNoiseBand(scrollHistory.map((run) => run.droppedFramePercent))
      } : undefined;
      if(calibrated) ++calibratedScenarios;

      if(!headSamples.length) {
        addFailure(blockingFailures, scale, scenario.key, 'no head measurement was recorded');
      }
      if(headSamples.length < requiredRepeats) {
        addFailure(blockingFailures, scale, scenario.key, `expected at least ${requiredRepeats} repeat measurements, got ${headSamples.length}`);
      }
      if(scenario.key === 'contactsList') {
        for(const [variant, samples] of [['base', baseSamples], ['head', headSamples]]) {
          const bundleSizes = samples.map((sample) => sample?.bundleBytes).filter(Number.isFinite);
          if(new Set(bundleSizes).size > 1) {
            addFailure(blockingFailures, scale, scenario.key, `${variant} bundle measurements vary across repeats`);
          }
        }
      }
      headSamples.forEach((sample, index) => {
        const requiredMetrics = scenario.key === 'scrollBack2k' ? [
          ...REQUIRED_METRICS,
          ['frameIntervals', 'frame interval count'],
          ['droppedFrames', 'dropped frame count'],
          ['droppedFramePercent', 'dropped frame percentage']
        ] : REQUIRED_METRICS;
        for(const [field, label] of requiredMetrics) {
          if(!Number.isFinite(sample?.[field])) {
            addFailure(blockingFailures, scale, scenario.key, `${label} is missing or invalid in head sample ${index + 1}`);
          }
        }
        if(scenario.key === 'scrollBack2k' && Number.isFinite(sample?.frameIntervals) && sample.frameIntervals <= 0) {
          addFailure(blockingFailures, scale, scenario.key, `frame interval count must be positive in head sample ${index + 1}`);
        }
        if(scenario.key === 'scrollBack2k' && Number.isFinite(sample?.droppedFrames) && sample.droppedFrames < 0) {
          addFailure(blockingFailures, scale, scenario.key, `dropped frame count cannot be negative in head sample ${index + 1}`);
        }
      });

      if(report.requireBase) {
        if(baseSamples.length < PERFORMANCE_REPEATS) {
          addFailure(blockingFailures, scale, scenario.key, `base bundle baseline requires ${PERFORMANCE_REPEATS} repeats, got ${baseSamples.length}`);
        }
        if(scale === '100x' && scenario.key === 'coldChatList' && baseSamples.length < COLD_CHAT_LIST_REPEATS) {
          addFailure(blockingFailures, scale, scenario.key, `base cold-load baseline requires ${COLD_CHAT_LIST_REPEATS} repeats, got ${baseSamples.length}`);
        }
        baseSamples.forEach((sample, index) => {
          if(!Number.isFinite(sample?.bundleBytes)) {
            addFailure(blockingFailures, scale, scenario.key, `base bundle measurement is missing or invalid in sample ${index + 1}`);
          }
          if(scale === '100x' && scenario.key !== 'scrollBack2k' && scenario.key !== 'dateJump') {
            if(!Number.isFinite(sample?.longTasksOver50Ms)) {
              addFailure(blockingFailures, scale, scenario.key, `base long task counter is missing or invalid in sample ${index + 1}`);
            }
            if(!Number.isFinite(sample?.blockingTimeMs)) {
              addFailure(blockingFailures, scale, scenario.key, `base long-task blocking time is missing or invalid in sample ${index + 1}`);
            }
          }
        });
      }

      if(scale === '100x') {
        if(scenario.key === 'scrollBack2k') {
          if(scrollCalibrated) {
            const taskValues = scrollHistory.map((run) => run.longTasksOver50Ms);
            const taskBand = scrollNoiseBands.longTasksOver50Ms;
            const headLongTasks = medianMetric(headSamples, 'longTasksOver50Ms');
            if(Number.isFinite(headLongTasks) && headLongTasks > taskBand[1]) {
              addFailure(blockingFailures, scale, scenario.key, `median long task count ${headLongTasks} exceeded master noise band ${taskBand[0].toFixed(1)}–${taskBand[1].toFixed(1)} (${median(taskValues).toFixed(1)} median)`);
            }

            const blockingValues = scrollHistory.map((run) => run.blockingTimeMs);
            const blockingBand = scrollNoiseBands.blockingTimeMs;
            const headBlockingTime = medianBlockingTime(headSamples);
            if(Number.isFinite(headBlockingTime) && headBlockingTime - median(blockingValues) >= MIN_BLOCKING_TIME_REGRESSION_MS && headBlockingTime > blockingBand[1]) {
              addFailure(blockingFailures, scale, scenario.key, `median long-task blocking time ${headBlockingTime.toFixed(1)} ms exceeded master noise band ${blockingBand[0].toFixed(1)}–${blockingBand[1].toFixed(1)} ms by at least ${MIN_BLOCKING_TIME_REGRESSION_MS} ms`);
            }

            const droppedFrameBand = scrollNoiseBands.droppedFramePercent;
            const regressedRepeats = headSamples.filter((sample) => sample?.droppedFramePercent > droppedFrameBand[1]).length;
            const headDroppedFramePercent = medianMetric(headSamples, 'droppedFramePercent');
            if(Number.isFinite(headDroppedFramePercent) && regressedRepeats >= 2) {
              addFailure(blockingFailures, scale, scenario.key, `dropped frames in ${regressedRepeats} head repeats exceeded master noise band ${droppedFrameBand[0].toFixed(2)}–${droppedFrameBand[1].toFixed(2)}% (head median ${headDroppedFramePercent.toFixed(2)}%)`);
            }
          }
        } else {
          const baseMeasured = report.requireBase && baseSamples.length > 0 && baseSamples.every((sample) => Number.isFinite(sample?.longTasksOver50Ms));
          if(baseMeasured) {
            if(separatedRegression(headSamples, baseSamples, 'longTasksOver50Ms')) {
              addFailure(blockingFailures, scale, scenario.key, `long task count rose in every head repeat above every same-run base repeat`);
            }
            const medianHeadBlockingTime = medianBlockingTime(headSamples);
            const medianBaseBlockingTime = medianBlockingTime(baseSamples);
            // Variants run in interleaved rounds; compare their paired cold-load deltas to cancel runner drift.
            const coldLoadBlockingTimeRegression = scenario.key === 'coldChatList' &&
              medianPairedDifference(headSamples, baseSamples, 'blockingTimeMs') >= MIN_SEPARATED_BLOCKING_TIME_REGRESSION_MS;
            const blockingTimeRegression = scenario.key === 'coldChatList'
              ? coldLoadBlockingTimeRegression
              : separatedRegression(headSamples, baseSamples, 'blockingTimeMs', MIN_SEPARATED_BLOCKING_TIME_REGRESSION_MS);
            if(blockingTimeRegression) {
              const message = scenario.key === 'coldChatList'
                ? `median paired long-task blocking time increase was at least ${MIN_SEPARATED_BLOCKING_TIME_REGRESSION_MS} ms (${medianHeadBlockingTime.toFixed(1)} ms vs ${medianBaseBlockingTime.toFixed(1)} ms medians)`
                : `long-task blocking time rose in every head repeat above every same-run base repeat, median ${medianHeadBlockingTime.toFixed(1)} ms vs ${medianBaseBlockingTime.toFixed(1)} ms`;
              addFailure(blockingFailures, scale, scenario.key, message);
            }
          } else {
            const baselineLongTasks = report.requireBase ? 0 : historyLongTaskBaseline(history, scale, scenario.key, report);
            const baselineBlockingTime = report.requireBase ? undefined : historyBlockingTimeBaseline(history, scale, scenario.key, report);
            const headLongTasks = medianLongTasks(headSamples);
            const headBlockingTime = medianBlockingTime(headSamples);
            if(Number.isFinite(baselineLongTasks) && Number.isFinite(headLongTasks) && headLongTasks > baselineLongTasks) {
              addFailure(blockingFailures, scale, scenario.key, `median long task count ${headLongTasks} exceeded baseline ${baselineLongTasks}`);
            }
            if(Number.isFinite(baselineBlockingTime) && Number.isFinite(headBlockingTime) && headBlockingTime - baselineBlockingTime >= MIN_BLOCKING_TIME_REGRESSION_MS) {
              addFailure(blockingFailures, scale, scenario.key, `median long-task blocking time ${headBlockingTime.toFixed(1)} ms exceeded base median ${baselineBlockingTime.toFixed(1)} ms by at least ${MIN_BLOCKING_TIME_REGRESSION_MS} ms`);
            }
          }
        }
      }

      const scrollGateStatus = scale !== '100x' || scenario.key !== 'scrollBack2k' || scrollCalibrated ? undefined : `report only (scroll noise band warming ${scrollHistoryRuns}/${CALIBRATION_RUNS})`;

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
        scrollHistoryRuns: scale === '100x' && scenario.key === 'scrollBack2k' ? scrollHistoryRuns : undefined,
        scrollNoiseBands,
        scrollGateStatus,
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
    '| Scenario | Head (ms) | Budget (ms) | Main noise band (ms) | 100x/1x | Scroll noise band | Base (ms) | Requests | DOM nodes | Long tasks >50 ms | Blocking time (ms) | Dropped frames | Bundle (bytes) | Gate |',
    '| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for(const row of evaluation.rows) {
    const show = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
    const budget = row.budgetMs === null ? '—' : row.budgetMs;
    const noise = row.noiseBand ? `${show(row.noiseBand[0], 1)}–${show(row.noiseBand[1], 1)}` : `warming ${row.historyRuns}/${CALIBRATION_RUNS}`;
    const scrollNoise = row.scale !== '100x' || row.key !== 'scrollBack2k' ? '—' : row.scrollNoiseBands ? `tasks ${show(row.scrollNoiseBands.longTasksOver50Ms[0], 1)}–${show(row.scrollNoiseBands.longTasksOver50Ms[1], 1)}; blocking ${show(row.scrollNoiseBands.blockingTimeMs[0], 1)}–${show(row.scrollNoiseBands.blockingTimeMs[1], 1)} ms; frames ${show(row.scrollNoiseBands.droppedFramePercent[0], 2)}–${show(row.scrollNoiseBands.droppedFramePercent[1], 2)}%` : `warming ${row.scrollHistoryRuns}/${CALIBRATION_RUNS}`;
    const smallHistoryRuns = evaluation.rows.find((item) => item.scale === '1x' && item.key === row.key)?.historyRuns || 0;
    const ratio = row.scale !== '100x' ? '—' : Number.isFinite(row.scaleRatio) ? `${show(row.scaleRatio, 2)}x` : `warming ${Math.min(row.historyRuns, smallHistoryRuns)}/${CALIBRATION_RUNS}`;
    const overBudget = row.budgetMs !== null && Number.isFinite(row.head.ms) && row.head.ms > row.budgetMs;
    const scenarioFailure = evaluation.blockingFailures.some((failure) => failure.startsWith(`${row.scale} ${row.key}:`));
    const gate = row.budgetStatus === 'failed' || scenarioFailure ? 'failed' : row.scrollGateStatus || (row.budgetStatus === 'warming' ? overBudget ? 'over budget (report only)' : 'report only' : 'calibrated');
    lines.push(`| ${row.label} (${row.scale}) | ${show(row.head.ms, 1)} | ${budget} | ${noise} | ${ratio} | ${scrollNoise} | ${show(row.base.ms, 1)} | ${show(row.head.requests)} | ${show(row.head.domNodes)} | ${show(row.head.longTasksOver50Ms)} | ${show(row.head.blockingTimeMs, 1)} | ${show(row.head.droppedFramePercent, 2)}% | ${show(row.head.bundleBytes)} | ${gate} |`);
  }
  return lines.join('\n');
}

export const calibrationRunCount = CALIBRATION_RUNS;
