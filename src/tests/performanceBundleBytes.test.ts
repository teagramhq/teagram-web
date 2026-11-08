import {describe, expect, test} from 'vitest';
import {createBundleRequestTracker, sumBundleBytes} from '../../e2e/performanceBundleBytes';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('scenario bundle byte measurement', () => {
  test('includes only same-origin script and style resources started within the scenario boundary', () => {
    const resources = [
      {name: 'https://app.test/before.js', startTime: 99, decodedBodySize: 1_000},
      {name: 'https://app.test/main.js?v=1', startTime: 100, decodedBodySize: 100},
      {name: 'https://app.test/main.js?v=1', startTime: 200, decodedBodySize: 100},
      {name: 'https://app.test/theme.css', startTime: 1_090, decodedBodySize: 250},
      {name: 'https://app.test/lazy.js', startTime: 1_101, decodedBodySize: 500},
      {name: 'https://cdn.test/vendor.js', startTime: 500, decodedBodySize: 700},
      {name: 'https://app.test/avatar.png', startTime: 500, decodedBodySize: 900}
    ];

    expect(sumBundleBytes(resources, 'https://app.test', 100, 1_100)).toBe(350);
    expect(sumBundleBytes(resources, 'https://app.test', 100, 1_100, ['https://app.test/main.js?v=1'])).toBe(250);
  });

  test('waits for matching requests to finish or fail before starting the quiet period', async() => {
    const tracker = createBundleRequestTracker('https://app.test');
    const script = {url: () => 'https://app.test/slow-route.js'};
    const stylesheet = {url: () => 'https://app.test/route.css'};
    const externalScript = {url: () => 'https://cdn.test/vendor.js'};
    const blobScript = {url: () => 'blob:https://app.test/worker'};
    const image = {url: () => 'https://app.test/avatar.png'};
    tracker.requestStarted(script);
    tracker.requestStarted(stylesheet);
    tracker.requestStarted(externalScript);
    tracker.requestStarted(blobScript);
    tracker.requestStarted(image);

    let settled = false;
    const waiting = tracker.waitForIdle(25, 500).then(() => settled = true);
    await wait(40);
    expect(settled).toBe(false);

    tracker.requestFinished(script);
    await wait(40);
    expect(settled).toBe(false);

    tracker.requestFailed(stylesheet);
    await waiting;
    expect(settled).toBe(true);
  });

  test('settles only a matching worker script request when its worker becomes ready', async() => {
    const tracker = createBundleRequestTracker('https://app.test');
    const workerUrl = 'https://app.test/crypto.worker.js';
    tracker.requestStarted({url: () => workerUrl});

    let settled = false;
    const waiting = tracker.waitForIdle(25, 500).then(() => settled = true);
    tracker.workerReady('https://app.test/other.worker.js');
    await wait(40);
    expect(settled).toBe(false);

    tracker.workerReady(workerUrl);
    await waiting;

    expect(settled).toBe(true);
  });
});
