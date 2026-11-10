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

/**
 * @param {{method: string, query: string, startedAtMs: number, returnedAtMs: number}[]} calls
 * @param {{query: string, debounceSettledAtMs: number, matchingResultVisibleAtMs: number}} boundary
 * @returns {{method: string, query: string, startedAtMs: number, returnedAtMs: number} | undefined}
 */
export function findMatchingGlobalSearchRpc(calls, {query, debounceSettledAtMs, matchingResultVisibleAtMs}) {
  if(!Array.isArray(calls)) return undefined;

  return calls
  .filter((call) => call?.method === 'messages.searchGlobal' && call.query === query &&
    Number.isFinite(call.startedAtMs) && call.startedAtMs >= debounceSettledAtMs &&
    Number.isFinite(call.returnedAtMs) && call.returnedAtMs >= call.startedAtMs &&
    call.returnedAtMs <= matchingResultVisibleAtMs)
  .sort((left, right) => left.startedAtMs - right.startedAtMs)
  .at(-1);
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
