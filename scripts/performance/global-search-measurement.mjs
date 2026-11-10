const GLOBAL_SEARCH_STAGE_KEYS = Object.freeze([
  'queryEnteredAtMs',
  'debounceSettledAtMs',
  'matchingSearchRpcReturnedAtMs',
  'matchingResultVisibleAtMs'
]);

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
