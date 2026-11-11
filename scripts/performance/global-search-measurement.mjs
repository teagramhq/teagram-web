const GLOBAL_SEARCH_STAGE_KEYS = Object.freeze([
  'queryEnteredAtMs',
  'debounceSettledAtMs',
  'matchingSearchRpcReturnedAtMs',
  'matchingResultVisibleAtMs'
]);
export const GLOBAL_SEARCH_WARMUP_BUDGET_MS = 60_000;

export function isCurrentGlobalSearchResult({query, inputValue, messageText, visible, presentBeforeQuery}) {
  return query.length > 0 && inputValue === query && visible && !presentBeforeQuery &&
    messageText.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

export function hasValidGlobalSearchStages(stages, sampleMs) {
  if(!stages) return false;
  const timestamps = GLOBAL_SEARCH_STAGE_KEYS.map((key) => stages[key]);
  if(!timestamps.every(Number.isFinite)) return false;
  if(timestamps.some((timestamp, index) => index > 0 && timestamp < timestamps[index - 1])) return false;

  const elapsedMs = stages.matchingResultVisibleAtMs - stages.queryEnteredAtMs;
  return sampleMs === undefined || (Number.isFinite(sampleMs) && Math.abs(sampleMs - elapsedMs) <= 0.01);
}

export function globalSearchSampleMs(stages) {
  if(!hasValidGlobalSearchStages(stages)) {
    throw new Error('global-search stage timestamps are missing or out of order');
  }
  return stages.matchingResultVisibleAtMs - stages.queryEnteredAtMs;
}

export function summarizeGlobalSearchWarmups(durationsMs) {
  if(!Array.isArray(durationsMs) || durationsMs.length === 0) {
    throw new Error('global-search warm-up must include at least one duration');
  }
  if(!durationsMs.every((duration) => Number.isFinite(duration) && duration >= 0)) {
    throw new Error('global-search warm-up durations must be finite non-negative numbers');
  }

  return {
    sampleCount: durationsMs.length,
    totalMs: durationsMs.reduce((total, duration) => total + duration, 0),
    maxMs: Math.max(...durationsMs)
  };
}
