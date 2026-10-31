import {describe, expect, test} from 'vitest';
import {sumBundleBytes} from '../../e2e/performanceBundleBytes';

describe('scenario bundle byte measurement', () => {
  test('includes only same-origin script and style resources started within the scenario boundary', () => {
    const resources = [
      {name: 'https://app.test/before.js', startTime: 99, decodedBodySize: 1_000},
      {name: 'https://app.test/main.js?v=1', startTime: 100, decodedBodySize: 100},
      {name: 'https://app.test/theme.css', startTime: 1_090, decodedBodySize: 250},
      {name: 'https://app.test/lazy.js', startTime: 1_101, decodedBodySize: 500},
      {name: 'https://cdn.test/vendor.js', startTime: 500, decodedBodySize: 700},
      {name: 'https://app.test/avatar.png', startTime: 500, decodedBodySize: 900}
    ];

    expect(sumBundleBytes(resources, 'https://app.test', 100, 1_100)).toBe(350);
  });
});
