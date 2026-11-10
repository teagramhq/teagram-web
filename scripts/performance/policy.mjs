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
export const PERFORMANCE_MEASUREMENT_VERSION = 3;
export const PERFORMANCE_REPEATS = 9;
export const COLD_CHAT_LIST_REPEATS = PERFORMANCE_REPEATS;
export const PAIRED_CONFIDENCE_LEVEL = 0.95;
export const TIMING_MINIMUM_EFFECTS = Object.freeze({
  scenarioTiming: Object.freeze({minimumMs: 2, baseMedianFraction: 0.15}),
  absoluteBudgets: Object.freeze({coldChatList: 1_000, warmChatList: 300, chatOpen: 200}),
  scaleRatio: 1.5,
  longTasksOver50Ms: 1,
  blockingTimeMs: 25,
  droppedFramePercent: Object.freeze({baseMedianFraction: 0.15}),
  walkMirrorLongTasks: 1,
  firstStickerVisibleFrameMs: 100,
  workerRecorder: Object.freeze({maximumMs: 2, baseMedianFraction: 0.15})
});

export function scenarioBundleBytes(resources, origin, startedAt, previouslyLoadedUrls = []) {
  const previousUrls = new Set(previouslyLoadedUrls);
  const bundleResources = new Map();
  resources.filter((entry) => {
    return entry.startTime >= startedAt &&
      !previousUrls.has(entry.name) &&
      new URL(entry.name).origin === origin &&
      /\.(js|css)(?:[?#]|$)/i.test(entry.name);
  }).forEach((entry) => bundleResources.set(entry.name, entry.decodedBodySize));
  return [...bundleResources.values()].reduce((total, bytes) => total + bytes, 0);
}

const CALIBRATION_RUNS = 20;
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
    // Lazy chunks can load before a scenario clears resource timings, so preserve their largest observed byte count.
    return [key, (key === 'longTasksOver50Ms' || key === 'bundleBytes') && values.length ? Math.max(...values) : median(values)];
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

function medianMetric(samples, field) {
  if(!Array.isArray(samples) || !samples.length) return undefined;
  const values = samples.map((sample) => sample?.[field]);
  return values.every(Number.isFinite) ? median(values) : undefined;
}

function pairedDifferences(baseValues, headValues) {
  if(!Array.isArray(baseValues) || !Array.isArray(headValues) || baseValues.length !== PERFORMANCE_REPEATS || headValues.length !== PERFORMANCE_REPEATS) return undefined;
  const differences = headValues.map((value, index) => value - baseValues[index]);
  return differences.every(Number.isFinite) ? differences : undefined;
}

function binomialTailHalf(n, firstSuccessCount) {
  let total = 0;
  for(let successes = firstSuccessCount; successes <= n; ++successes) {
    let coefficient = 1;
    for(let i = 1; i <= successes; ++i) coefficient = coefficient * (n - i + 1) / i;
    total += coefficient / 2 ** n;
  }
  return total;
}

function signTestLowerBoundIndex(sampleCount) {
  let index = 0;
  for(let order = 1; order <= sampleCount; ++order) {
    if(binomialTailHalf(sampleCount, order) < PAIRED_CONFIDENCE_LEVEL) break;
    index = order - 1;
  }
  return index;
}

export function pairedMedianLowerConfidenceBound(differences) {
  if(!Array.isArray(differences) || differences.length !== PERFORMANCE_REPEATS || !differences.every(Number.isFinite)) return undefined;
  const sorted = [...differences].sort((left, right) => left - right);
  return sorted[signTestLowerBoundIndex(sorted.length)];
}

export function evaluatePairedDifferences(differences, minimumEffect, {inclusive = false} = {}) {
  const lowerBound = pairedMedianLowerConfidenceBound(differences);
  if(!Number.isFinite(lowerBound) || !Number.isFinite(minimumEffect)) {
    return {lowerBound: undefined, minimumEffect, regression: false};
  }
  return {
    lowerBound,
    minimumEffect,
    regression: inclusive ? lowerBound >= minimumEffect : lowerBound > minimumEffect
  };
}

function addFailure(failures, scale, key, message) {
  failures.push(`${scale} ${key}: ${message}`);
}

function walkMirrorSamples(report, variant, scenarioKey) {
  const diagnostic = report.diagnostics?.['100x'];
  return diagnostic?.walkComparison?.[variant]?.[scenarioKey] || (variant === 'head' ? diagnostic?.[scenarioKey] : undefined);
}

function walkMirrorCounts(report, variant, scale, scenarioKey, failures) {
  const samples = walkMirrorSamples(report, variant, scenarioKey);
  if(!Array.isArray(samples)) {
    addFailure(failures, scale, scenarioKey, `${variant} walk-mirror long-task diagnostic sample set is missing`);
    return undefined;
  }
  if(samples.length !== PERFORMANCE_REPEATS) {
    addFailure(failures, scale, scenarioKey, `${variant} walk-mirror diagnostic expected exactly ${PERFORMANCE_REPEATS} samples, got ${samples.length}`);
    return undefined;
  }
  const counts = samples.map((sample, index) => sample?.walkLongTasksOver50Ms);
  if(!counts.every((count) => Number.isInteger(count) && count >= 0)) {
    const invalid = counts.findIndex((count) => !Number.isInteger(count) || count < 0);
    addFailure(failures, scale, scenarioKey, `${variant} walk-mirror long-task diagnostic is missing or invalid in sample ${invalid + 1}`);
    return undefined;
  }
  return counts;
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
      blockingTimeMs: medianMetric(samples, 'blockingTimeMs'),
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

export function evaluatePerformance(report, history = []) {
  const rows = [];
  const blockingFailures = [];
  const reportOnlyFailures = [];
  let calibratedScenarios = 0;

  for(const scale of SCALES) {
    for(const scenario of SCENARIOS) {
      const rawBaseSamples = report.variants?.base?.[scale]?.[scenario.key];
      const rawHeadSamples = report.variants?.head?.[scale]?.[scenario.key];
      const baseSamples = Array.isArray(rawBaseSamples) ? rawBaseSamples : [];
      const headSamples = Array.isArray(rawHeadSamples) ? rawHeadSamples : [];
      const base = summarizeSamples(baseSamples);
      const head = summarizeSamples(headSamples);
      const timingFailures = [];
      let gateFailure = false;
      const budgetMs = scale === '100x' ? TIMING_MINIMUM_EFFECTS.absoluteBudgets[scenario.key] ?? null : null;
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

      const variantsToValidate = report.requireBase ? [['base', baseSamples], ['head', headSamples]] : [['head', headSamples]];
      for(const [variant, samples] of variantsToValidate) {
        if(samples.length !== PERFORMANCE_REPEATS) {
          addFailure(blockingFailures, scale, scenario.key, `${variant} expected exactly ${PERFORMANCE_REPEATS} samples, got ${samples.length}`);
          gateFailure = true;
        }
        samples.forEach((sample, index) => {
          const requiredMetrics = scenario.key === 'scrollBack2k' ? [
            ...REQUIRED_METRICS,
            ['frameIntervals', 'frame interval count'],
            ['droppedFrames', 'dropped frame count'],
            ['droppedFramePercent', 'dropped frame percentage']
          ] : REQUIRED_METRICS;
          for(const [field, label] of requiredMetrics) {
            if(!Number.isFinite(sample?.[field])) {
              addFailure(blockingFailures, scale, scenario.key, `${variant} ${label} is missing or invalid in sample ${index + 1}`);
              gateFailure = true;
            }
          }
          if(scenario.key === 'scrollBack2k' && Number.isFinite(sample?.frameIntervals) && sample.frameIntervals <= 0) {
            addFailure(blockingFailures, scale, scenario.key, `${variant} frame interval count must be positive in sample ${index + 1}`);
            gateFailure = true;
          }
          if(scenario.key === 'scrollBack2k' && Number.isFinite(sample?.droppedFrames) && sample.droppedFrames < 0) {
            addFailure(blockingFailures, scale, scenario.key, `${variant} dropped frame count cannot be negative in sample ${index + 1}`);
            gateFailure = true;
          }
        });
      }

      if(scenario.key === 'contactsList') {
        for(const [variant, samples] of variantsToValidate) {
          const bundleSizes = samples.map((sample) => sample?.bundleBytes).filter(Number.isFinite);
          if(new Set(bundleSizes).size > 1) {
            addFailure(blockingFailures, scale, scenario.key, `${variant} bundle measurements vary across repeats`);
            gateFailure = true;
          }
        }
      }

      if(report.requireBase) {
        if(scenario.key === 'coldChatList' || scenario.key === 'warmChatList') {
          const startupMetrics = [
            ['requests', medianMetric(baseSamples, 'requests'), medianMetric(headSamples, 'requests')],
            ['rpcCallCount', medianMetric(baseSamples, 'rpcCallCount'), medianMetric(headSamples, 'rpcCallCount')],
            ['bundleBytes', base.bundleBytes, head.bundleBytes]
          ];
          for(const [field, baseValue, headValue] of startupMetrics) {
            if(!Number.isFinite(baseValue) || !Number.isFinite(headValue)) {
              addFailure(blockingFailures, scale, scenario.key, `${field} is missing at the chat-list boundary`);
              gateFailure = true;
            } else if(headValue > baseValue) {
              addFailure(blockingFailures, scale, scenario.key, `${field} increased from ${baseValue} to ${headValue} at the chat-list boundary`);
              gateFailure = true;
            }
          }
        }

        if(Number.isFinite(head.bundleBytes) && Number.isFinite(base.bundleBytes) && head.bundleBytes > base.bundleBytes * 1.02) {
          addFailure(blockingFailures, scale, scenario.key, `bundle grew from ${base.bundleBytes} to ${head.bundleBytes} bytes (over 2%)`);
          gateFailure = true;
        }

        const applyTimingGate = (name, differences, minimumEffect, minimumEffectText, {inclusive = false} = {}) => {
          if(!differences) return;
          const gate = evaluatePairedDifferences(differences, minimumEffect, {inclusive});
          if(!gate.regression) return;
          const comparison = inclusive ? 'met or exceeded' : 'exceeded';
          const message = `${name}: one-sided ${Math.round(PAIRED_CONFIDENCE_LEVEL * 100)}% median lower bound ${gate.lowerBound.toFixed(2)} ${comparison} minimum effect ${minimumEffectText}`;
          addFailure(blockingFailures, scale, scenario.key, message);
          timingFailures.push(message);
          gateFailure = true;
        };

        const baseTimes = baseSamples.map((sample) => sample?.ms);
        const headTimes = headSamples.map((sample) => sample?.ms);
        const timeDifferences = pairedDifferences(baseTimes, headTimes);
        if(timeDifferences) {
          const baseMedian = median(baseTimes);
          const relativeMinimum = Math.max(
            TIMING_MINIMUM_EFFECTS.scenarioTiming.minimumMs,
            baseMedian * TIMING_MINIMUM_EFFECTS.scenarioTiming.baseMedianFraction
          );
          applyTimingGate('response timing', timeDifferences, relativeMinimum, `${relativeMinimum.toFixed(2)} ms (${TIMING_MINIMUM_EFFECTS.scenarioTiming.baseMedianFraction * 100}% of base median, at least ${TIMING_MINIMUM_EFFECTS.scenarioTiming.minimumMs} ms)`);
          if(budgetMs !== null) {
            const budgetHeadroom = Math.max(0, budgetMs - baseMedian);
            applyTimingGate('absolute timing budget', timeDifferences, budgetHeadroom, `${budgetHeadroom.toFixed(2)} ms to the ${budgetMs} ms budget`);
          }
        }

        if(scale === '100x') {
          const baseTasks = baseSamples.map((sample) => sample?.longTasksOver50Ms);
          const headTasks = headSamples.map((sample) => sample?.longTasksOver50Ms);
          applyTimingGate(
            'long-task count',
            pairedDifferences(baseTasks, headTasks),
            TIMING_MINIMUM_EFFECTS.longTasksOver50Ms,
            `${TIMING_MINIMUM_EFFECTS.longTasksOver50Ms} additional long task(s)`
          );

          const baseBlocking = baseSamples.map((sample) => sample?.blockingTimeMs);
          const headBlocking = headSamples.map((sample) => sample?.blockingTimeMs);
          applyTimingGate(
            'long-task blocking time',
            pairedDifferences(baseBlocking, headBlocking),
            TIMING_MINIMUM_EFFECTS.blockingTimeMs,
            `${TIMING_MINIMUM_EFFECTS.blockingTimeMs} ms`
          );

          if(scenario.key === 'scrollBack2k') {
            const baseDroppedFrames = baseSamples.map((sample) => sample?.droppedFramePercent);
            const headDroppedFrames = headSamples.map((sample) => sample?.droppedFramePercent);
            const droppedFrameMinimum = Math.max(0, median(baseDroppedFrames) * TIMING_MINIMUM_EFFECTS.droppedFramePercent.baseMedianFraction);
            applyTimingGate(
              'dropped-frame percentage',
              pairedDifferences(baseDroppedFrames, headDroppedFrames),
              droppedFrameMinimum,
              `${droppedFrameMinimum.toFixed(2)} percentage points (${TIMING_MINIMUM_EFFECTS.droppedFramePercent.baseMedianFraction * 100}% of base median)`
            );
          }
        }
      }

      let walkLongTasksOver50Ms;
      if(scale === '100x') {
        const headWalkCounts = walkMirrorCounts(report, 'head', scale, scenario.key, blockingFailures);
        walkLongTasksOver50Ms = headWalkCounts ? Math.max(...headWalkCounts) : undefined;
        if(!headWalkCounts) gateFailure = true;
        const baseWalkCounts = report.requireBase ? walkMirrorCounts(report, 'base', scale, scenario.key, blockingFailures) : undefined;
        if(report.requireBase && !baseWalkCounts) gateFailure = true;
        if(report.requireBase && baseWalkCounts && headWalkCounts) {
          const differences = pairedDifferences(baseWalkCounts, headWalkCounts);
          const gate = differences && evaluatePairedDifferences(
            differences,
            TIMING_MINIMUM_EFFECTS.walkMirrorLongTasks
          );
          if(gate?.regression) {
            const message = `walk-mirror long-task count: one-sided ${Math.round(PAIRED_CONFIDENCE_LEVEL * 100)}% median lower bound ${gate.lowerBound.toFixed(2)} exceeded minimum effect ${TIMING_MINIMUM_EFFECTS.walkMirrorLongTasks} additional long task(s)`;
            addFailure(blockingFailures, scale, scenario.key, message);
            timingFailures.push(message);
            gateFailure = true;
          }
        }
      }

      const noiseWidth = calibrated ? timingNoise(mainValues) : undefined;
      rows.push({
        ...scenario,
        scale,
        budgetMs,
        base,
        head,
        walkLongTasksOver50Ms,
        scrollHistoryRuns: scale === '100x' && scenario.key === 'scrollBack2k' ? scrollHistoryRuns : undefined,
        scrollNoiseBands,
        historyRuns: mainValues.length,
        noiseBand: calibrated ? [median(mainValues) - noiseWidth, median(mainValues) + noiseWidth] : undefined,
        budgetStatus: report.requireBase ? 'paired' : 'calibration',
        reportOnlyFailure: false,
        gateFailure,
        timingFailures
      });
    }
  }

  if(report.requireBase) {
    for(const scenario of SCENARIOS) {
      const baseSmall = report.variants.base?.['1x']?.[scenario.key]?.map((sample) => sample?.ms) || [];
      const headSmall = report.variants.head?.['1x']?.[scenario.key]?.map((sample) => sample?.ms) || [];
      const baseLarge = report.variants.base?.['100x']?.[scenario.key]?.map((sample) => sample?.ms) || [];
      const headLarge = report.variants.head?.['100x']?.[scenario.key]?.map((sample) => sample?.ms) || [];
      const small = rows.find((row) => row.scale === '1x' && row.key === scenario.key);
      const large = rows.find((row) => row.scale === '100x' && row.key === scenario.key);
      if(!small || !large || ![baseSmall, headSmall, baseLarge, headLarge].every((values) => values.length === PERFORMANCE_REPEATS && values.every(Number.isFinite))) continue;
      if([...baseSmall, ...headSmall].some((value) => value <= 0)) {
        addFailure(blockingFailures, '100x/1x', scenario.key, 'scale ratio requires positive 1x timing samples');
        large.gateFailure = true;
        continue;
      }
      const baseRatios = baseLarge.map((value, index) => value / baseSmall[index]);
      const headRatios = headLarge.map((value, index) => value / headSmall[index]);
      large.scaleRatio = median(headRatios);
      const differences = pairedDifferences(baseRatios, headRatios);
      const minimumEffect = Math.max(0, TIMING_MINIMUM_EFFECTS.scaleRatio - median(baseRatios));
      const gate = differences && evaluatePairedDifferences(differences, minimumEffect);
      if(gate?.regression) {
        const message = `100x/1x ${scenario.key}: one-sided ${Math.round(PAIRED_CONFIDENCE_LEVEL * 100)}% median lower bound ${gate.lowerBound.toFixed(2)} exceeded the paired effect that crosses the ${TIMING_MINIMUM_EFFECTS.scaleRatio.toFixed(2)}x ceiling`;
        blockingFailures.push(message);
        large.timingFailures.push(message);
        large.gateFailure = true;
      }
    }
  }

  return {rows, blockingFailures, reportOnlyFailures, calibratedScenarios};
}

export function formatPerformanceTable(evaluation) {
  const lines = [
    '| Scenario | Head (ms) | Budget (ms) | Main noise band (ms) | 100x/1x | Scroll calibration band | Base (ms) | Requests | DOM nodes | Long tasks >50 ms | Walk-mirror tasks >50 ms (head max/repeat) | Blocking time (ms) | Dropped frames | Bundle (bytes) | Gate |',
    '| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for(const row of evaluation.rows) {
    const show = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
    const budget = row.budgetMs === null ? '—' : row.budgetMs;
    const noise = row.noiseBand ? `${show(row.noiseBand[0], 1)}–${show(row.noiseBand[1], 1)}` : `calibration ${row.historyRuns}/${CALIBRATION_RUNS}`;
    const scrollNoise = row.scale !== '100x' || row.key !== 'scrollBack2k' ? '-' : row.scrollNoiseBands ? `tasks ${show(row.scrollNoiseBands.longTasksOver50Ms[0], 1)}–${show(row.scrollNoiseBands.longTasksOver50Ms[1], 1)}; blocking ${show(row.scrollNoiseBands.blockingTimeMs[0], 1)}–${show(row.scrollNoiseBands.blockingTimeMs[1], 1)} ms; frames ${show(row.scrollNoiseBands.droppedFramePercent[0], 2)}–${show(row.scrollNoiseBands.droppedFramePercent[1], 2)}%` : `calibration ${row.scrollHistoryRuns}/${CALIBRATION_RUNS}`;
    const ratio = row.scale !== '100x' ? '-' : Number.isFinite(row.scaleRatio) ? `${show(row.scaleRatio, 2)}x` : 'n/a';
    const scenarioFailure = evaluation.blockingFailures.some((failure) => failure.startsWith(`${row.scale} ${row.key}:`));
    const gate = scenarioFailure || row.gateFailure ? 'failed' : row.budgetStatus === 'paired' ? 'passed' : 'calibration';
    const walkLongTasks = Number.isFinite(row.walkLongTasksOver50Ms) ? show(row.walkLongTasksOver50Ms) : '—';
    lines.push(`| ${row.label} (${row.scale}) | ${show(row.head.ms, 1)} | ${budget} | ${noise} | ${ratio} | ${scrollNoise} | ${show(row.base.ms, 1)} | ${show(row.head.requests)} | ${show(row.head.domNodes)} | ${show(row.head.longTasksOver50Ms)} | ${walkLongTasks} | ${show(row.head.blockingTimeMs, 1)} | ${show(row.head.droppedFramePercent, 2)}% | ${show(row.head.bundleBytes)} | ${gate} |`);
  }
  return lines.join('\n');
}

function summarizeTracePhases(samples) {
  const phases = new Map();
  for(const sample of samples) {
    const entries = [...(sample?.mainPhases || []), ...(sample?.workerPhases || [])];
    for(const phase of entries) {
      const key = `${phase.name}\0${phase.accountNumber ?? ''}`;
      const summary = phases.get(key) || {
        name: phase.name,
        accountNumber: phase.accountNumber,
        starts: [],
        durations: []
      };
      if(Number.isFinite(phase.startMs)) summary.starts.push(phase.startMs);
      if(Number.isFinite(phase.durationMs)) summary.durations.push(phase.durationMs);
      phases.set(key, summary);
    }
  }

  return new Map([...phases].map(([key, phase]) => [key, {
    ...phase,
    startMs: median(phase.starts),
    durationMs: median(phase.durations)
  }]));
}

export function formatPerformanceTraceTable(diagnostics) {
  const coldSamples = Array.isArray(diagnostics?.coldChatList) ? diagnostics.coldChatList : [];
  const warmSamples = Array.isArray(diagnostics?.warmChatList) ? diagnostics.warmChatList : [];
  if(!coldSamples.length && !warmSamples.length) return '';

  const cold = summarizeTracePhases(coldSamples);
  const warm = summarizeTracePhases(warmSamples);
  const keys = new Set([...cold.keys(), ...warm.keys()]);
  const entries = [...keys].map((key) => ({key, cold: cold.get(key), warm: warm.get(key)}));
  entries.sort((left, right) => {
    const leftStart = Math.min(left.cold?.startMs ?? Infinity, left.warm?.startMs ?? Infinity);
    const rightStart = Math.min(right.cold?.startMs ?? Infinity, right.warm?.startMs ?? Infinity);
    return leftStart - rightStart;
  });

  const show = (value) => Number.isFinite(value) ? value.toFixed(1) : 'n/a';
  const label = ({name, accountNumber}) => accountNumber === undefined ? name : `${name} (account ${accountNumber})`;
  const lines = [
    '### 100x startup trace spans',
    '',
    `Median start and duration in milliseconds from navigation across ${coldSamples.length} cold ${coldSamples.length === 1 ? 'repeat' : 'repeats'} and ${warmSamples.length} warm ${warmSamples.length === 1 ? 'repeat' : 'repeats'}.`,
    '',
    '| Span | Cold start | Cold duration | Warm start | Warm duration |',
    '| --- | ---: | ---: | ---: | ---: |'
  ];
  for(const entry of entries) {
    const phase = entry.cold || entry.warm;
    lines.push(`| ${label(phase)} | ${show(entry.cold?.startMs)} | ${show(entry.cold?.durationMs)} | ${show(entry.warm?.startMs)} | ${show(entry.warm?.durationMs)} |`);
  }

  const reconcileRows = SCENARIOS.map(({key}) => key).flatMap((scenario) => {
    const samples = Array.isArray(diagnostics?.[scenario]) ? diagnostics[scenario] : [];
    if(!samples.length) return [];
    const traces = samples.flatMap((sample) => Array.isArray(sample.cachedDialogReconcile?.walks) ? sample.cachedDialogReconcile.walks : []);
    const noWalkRepeats = samples.filter((sample) => Array.isArray(sample.cachedDialogReconcile?.walks) && !sample.cachedDialogReconcile.walks.length).length;

    const medianField = (field) => median(traces.map((trace) => trace[field]).filter(Number.isFinite));
    return [[
      scenario,
      traces.length,
      noWalkRepeats,
      show(medianField('pageCount')),
      show(medianField('startRelativeToScenarioMs')),
      show(medianField('endRelativeToScenarioMs')),
      show(medianField('mainThreadTimeMs'))
    ]];
  });
  if(reconcileRows.length) {
    lines.push(
      '',
      '### Cached channel dialog reconciliation diagnostics',
      '',
      'Per-walk summaries come from one opt-in 100x diagnostic pair; this table reports the head details. The blocking walk-mirror gate compares all paired measured samples in `diagnostics.100x.walkComparison`. Empty `walks` arrays count scenarios where no walk overlapped the window; diagnostic samples remain in `diagnostics.100x`. Offsets use each diagnostic scenario window.',
      '',
      '| Scenario | Walks | No-walk repeats | Median pages | Median start offset (ms) | Median end offset (ms) | Median main-thread time (ms) |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...reconcileRows.map((row) => `| ${row.join(' | ')} |`)
    );
  }
  return lines.join('\n');
}

export const calibrationRunCount = CALIBRATION_RUNS;
