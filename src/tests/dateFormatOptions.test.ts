import {expect, it} from 'vitest';
import {getDateFormatOptions} from '@lib/langPack';

it.each([
  ['today', new Date(2025, 4, 14, 9), new Date(2025, 4, 14, 12), {hour: '2-digit', minute: '2-digit'}],
  ['this week', new Date(2025, 4, 12, 9), new Date(2025, 4, 14, 12), {weekday: 'short'}],
  ['outside this week', new Date(2025, 4, 7, 9), new Date(2025, 4, 14, 12), {month: 'short', day: 'numeric'}],
  ['previous year', new Date(2024, 4, 14, 9), new Date(2025, 4, 14, 12), {year: 'numeric', day: 'numeric', month: '2-digit'}],
  ['same ISO week at new year', new Date(2025, 0, 1, 9), new Date(2025, 0, 2, 12), {weekday: 'short'}],
  ['different ISO week', new Date(2025, 0, 5, 9), new Date(2025, 0, 6, 12), {month: 'short', day: 'numeric'}]
])('selects normal chat row date options for %s', (_case, time, today, expected) => {
  expect(getDateFormatOptions(time, today)).toEqual(expected);
});
