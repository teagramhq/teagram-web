import {expect, test} from 'vitest';
import {findMatchingGlobalSearchRpc, globalSearchSampleMs, hasValidGlobalSearchStages, isCurrentGlobalSearchResult} from './global-search-measurement.mjs';

const query = 'needle 500000';

test('global search accepts only a new visible message row matching the current input', () => {
  const currentResult = {
    query,
    inputValue: query,
    messageText: `Fixture message containing ${query}`,
    visible: true,
    presentBeforeQuery: false
  };

  expect(isCurrentGlobalSearchResult(currentResult)).toBe(true);
  expect(isCurrentGlobalSearchResult({...currentResult, presentBeforeQuery: true})).toBe(false);
  expect(isCurrentGlobalSearchResult({...currentResult, inputValue: 'older query'})).toBe(false);
  expect(isCurrentGlobalSearchResult({...currentResult, messageText: 'unrelated fixture message'})).toBe(false);
  expect(isCurrentGlobalSearchResult({...currentResult, visible: false})).toBe(false);
});

test('global search duration is the visible-result timestamp minus query entry', () => {
  const stages = {
    queryEnteredAtMs: 100,
    debounceSettledAtMs: 400,
    matchingSearchRpcReturnedAtMs: 480,
    matchingResultVisibleAtMs: 500
  };

  expect(globalSearchSampleMs(stages)).toBe(400);
  expect(hasValidGlobalSearchStages(stages, 400)).toBe(true);
  expect(hasValidGlobalSearchStages(stages, 399)).toBe(false);
  expect(hasValidGlobalSearchStages({...stages, matchingSearchRpcReturnedAtMs: 390})).toBe(false);
  expect(hasValidGlobalSearchStages({...stages, matchingSearchRpcReturnedAtMs: null})).toBe(false);
});

test('global search selects the current query RPC that returned before its result became visible', () => {
  const calls = [
    {method: 'messages.searchGlobal', query, startedAtMs: 250, returnedAtMs: 280},
    {method: 'messages.searchGlobal', query: 'older query', startedAtMs: 320, returnedAtMs: 350},
    {method: 'messages.searchGlobal', query, startedAtMs: 320, returnedAtMs: 510},
    {method: 'messages.searchGlobal', query, startedAtMs: 330, returnedAtMs: 450},
    {method: 'messages.searchGlobal', query, startedAtMs: 350, returnedAtMs: 460},
    {method: 'messages.getHistory', query, startedAtMs: 360, returnedAtMs: 470}
  ];
  const boundary = {query, debounceSettledAtMs: 300, matchingResultVisibleAtMs: 500};

  expect(findMatchingGlobalSearchRpc(calls, boundary)).toBe(calls[4]);
  expect(findMatchingGlobalSearchRpc(calls.slice(0, 3), boundary)).toBeUndefined();
});
