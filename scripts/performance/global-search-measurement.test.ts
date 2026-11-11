import {expect, test} from 'vitest';
import {globalSearchSampleMs, hasValidGlobalSearchStages, isCurrentGlobalSearchResult, summarizeGlobalSearchWarmups} from './global-search-measurement.mjs';

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

test('global-search warm-up cost reports total elapsed time and rejects invalid samples', () => {
  expect(summarizeGlobalSearchWarmups([125.5, 400, 74.5])).toEqual({sampleCount: 3, totalMs: 600, maxMs: 400});
  expect(() => summarizeGlobalSearchWarmups([])).toThrow('at least one duration');
  expect(() => summarizeGlobalSearchWarmups([12, Number.NaN])).toThrow('finite non-negative');
  expect(() => summarizeGlobalSearchWarmups([12, -1])).toThrow('finite non-negative');
});
