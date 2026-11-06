import {expect, test} from '@playwright/test';
import {beginMeasurement, startMeasurementAtClick, waitForFirstVisibleBubble} from './performanceMeasurement';
import {createServer, type ServerResponse} from 'node:http';
import * as bundleMeasurement from './performanceBundleBytes';

test('forgets an abandoned shared-worker request after document reload', async({page}) => {
  const held: ServerResponse[] = [];
  let releaseResponses = false;
  const replyToWorker = (response: ServerResponse) => {
    if(!response.destroyed) response.end('onconnect = (event) => event.ports[0].postMessage("ready");');
  };
  const server = createServer((request, response) => {
    if(request.url === '/worker.js') {
      response.setHeader('Content-Type', 'text/javascript');
      if(releaseResponses) replyToWorker(response);
      else held.push(response);
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<script>const worker = new SharedWorker("/worker.js"); worker.port.onmessage = () => window.workerReady(); fetch("/worker.js").then(r => r.text());</script>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if(!address || typeof address === 'string') throw new Error('Server did not bind to a port');
    const origin = `http://127.0.0.1:${address.port}`;
    const tracker = bundleMeasurement.createBundleRequestTracker(origin);
    let workerStarts = 0;
    let readyCount = 0;
    bundleMeasurement.trackBundleDocumentNavigation(page, tracker);
    page.on('request', (request) => {
      if(request.url().endsWith('/worker.js') && request.resourceType() === 'script') ++workerStarts;
      tracker.requestStarted(request);
    });
    page.on('requestfinished', (request) => tracker.requestFinished(request));
    page.on('requestfailed', (request) => tracker.requestFailed(request));
    await page.exposeFunction('workerReady', () => { ++readyCount; tracker.workerReady(`${origin}/worker.js`); });
    await page.goto(origin, {waitUntil: 'domcontentloaded'});
    await expect.poll(() => workerStarts).toBe(1);
    expect(readyCount).toBe(0);
    await page.evaluate(() => { location.hash = 'same-document'; });
    await expect(tracker.waitForIdle(10, 100)).rejects.toThrow('did not settle');
    await page.reload({waitUntil: 'domcontentloaded'});
    await expect.poll(() => workerStarts).toBe(2);
    releaseResponses = true;
    held.forEach(replyToWorker);
    await tracker.waitForIdle(25, 3_000);
    expect(workerStarts).toBe(2);
    expect(readyCount).toBe(1);
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('starts the measured window when the browser dispatches the click', async({page}) => {
  await page.setContent('<button>Open chat</button>');
  await page.evaluate(() => {
    (window as any).__teagramPerf = {started: performance.now()};
  });
  const button = page.getByRole('button', {name: 'Open chat'});
  await button.evaluate((element) => element.addEventListener('click', (event) => event.stopImmediatePropagation(), {capture: true}));
  await startMeasurementAtClick(button);
  await page.waitForTimeout(30);
  await button.click();

  const measurement = await page.evaluate(() => (window as any).__teagramPerf);
  expect(measurement.started).toBeGreaterThan(0);
  expect(measurement.preInteractionMs).toBeGreaterThanOrEqual(30);
  expect(measurement.started).toBe(measurement.clickAt);
});

test('starts when the peer row is replaced after arming the click', async({page}) => {
  await page.setContent('<button class="chatlist-chat" data-peer-id="42">Open chat</button>');
  await page.evaluate(() => {
    (window as any).__teagramPerf = {started: performance.now()};
  });
  const row = page.locator('.chatlist-chat[data-peer-id="42"]');
  await startMeasurementAtClick(row);
  await row.evaluate((element) => element.replaceWith(element.cloneNode(true)));
  await page.locator('.chatlist-chat[data-peer-id="42"]').click();

  const clickAt = await page.evaluate(() => (window as any).__teagramPerf.clickAt);
  expect(Number.isFinite(clickAt)).toBe(true);
});

test('records the first visible bubble when it is mounted', async({page}) => {
  await page.setContent('<button class="chatlist-chat" data-peer-id="42">Open chat</button><main class="bubbles"></main>');
  await page.evaluate(() => {
    (window as any).__teagramPerf = {started: performance.now()};
  });
  const button = page.getByRole('button', {name: 'Open chat'});
  await startMeasurementAtClick(button);
  await button.evaluate((element) => element.addEventListener('click', () => {
    setTimeout(() => {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.dataset.mid = '1';
      bubble.dataset.peerId = '42';
      bubble.style.cssText = 'display:block;width:10px;height:10px';
      const insertedAt = performance.now();
      document.querySelector('.bubbles')!.append(bubble);
      (window as any).__teagramPerf.insertedAt = insertedAt;
    }, 20);
  }));
  await button.click();

  const boundary = await waitForFirstVisibleBubble(page);
  const result = await page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    return {boundary: perf.firstBubbleBoundary, insertedAt: perf.insertedAt};
  });
  expect(result.boundary.domNodes).toBeGreaterThan(0);
  expect(result.boundary.domClassCounts['div.bubble']).toBe(1);
  expect(result.boundary.preInteractionMs).toBeGreaterThanOrEqual(0);
  expect(Math.abs(result.boundary.startedAtMs + result.boundary.ms - result.insertedAt)).toBeLessThan(50);
});

test('records a bubble that becomes visible after a stylesheet layout change', async({page}) => {
  await page.setContent('<style>.bubble {display:block;width:10px;height:0}</style><button class="chatlist-chat" data-peer-id="42">Open chat</button><main class="bubbles"></main>');
  await page.evaluate(() => {
    (window as any).__teagramPerf = {started: performance.now()};
  });
  const button = page.getByRole('button', {name: 'Open chat'});
  await startMeasurementAtClick(button);
  await button.evaluate((element) => element.addEventListener('click', () => {
    setTimeout(() => {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.dataset.mid = '1';
      bubble.dataset.peerId = '42';
      document.querySelector('.bubbles')!.append(bubble);
      setTimeout(() => {
        const stylesheet = document.styleSheets[0] as CSSStyleSheet;
        stylesheet.insertRule('.bubble {height:10px}', stylesheet.cssRules.length);
      }, 20);
    }, 20);
  }));
  await button.click();

  const boundary = await waitForFirstVisibleBubble(page);
  expect(boundary.domNodes).toBeGreaterThan(0);
});

test('records a bubble that becomes visible after a stylesheet visibility change', async({page}) => {
  await page.setContent('<style>.bubble {display:block;width:10px;height:10px;visibility:hidden}</style><button class="chatlist-chat" data-peer-id="42">Open chat</button><main class="bubbles"></main>');
  await page.evaluate(() => {
    (window as any).__teagramPerf = {started: performance.now()};
  });
  const button = page.getByRole('button', {name: 'Open chat'});
  await startMeasurementAtClick(button);
  await button.evaluate((element) => element.addEventListener('click', () => {
    setTimeout(() => {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.dataset.mid = '1';
      bubble.dataset.peerId = '42';
      document.querySelector('.bubbles')!.append(bubble);
      setTimeout(() => {
        const stylesheet = document.styleSheets[0] as CSSStyleSheet;
        stylesheet.insertRule('.bubble {visibility:visible}', stylesheet.cssRules.length);
      }, 20);
    }, 20);
  }));
  await button.click();

  const boundary = await waitForFirstVisibleBubble(page);
  expect(boundary.domNodes).toBeGreaterThan(0);
});

test('arms worker recording and starts the window before queued worker messages run', async({page}) => {
  const measurement = await import('./performanceMeasurement') as any;
  expect(typeof measurement.beginMeasurement).toBe('function');
  await page.evaluate(() => {
    const channel = new MessageChannel();
    const perf: any = (window as any).__teagramPerf = {started: -1, longTasks: [{startTime: 1}], frameIntervals: [1]};
    channel.port1.onmessage = () => { perf.startedAtMessage = perf.started; };
    (window as any).__teagramInstallWorkerMessageAttribution = () => {
      channel.port2.postMessage('queued');
      return {spans: [] as unknown[]};
    };
    (window as any).apiManagerProxy = {};
  });
  const requests = {value: 5};
  await measurement.beginMeasurement(page, requests, true, false, true);
  await page.waitForFunction(() => (window as any).__teagramPerf.startedAtMessage !== undefined);
  const result = await page.evaluate(() => (window as any).__teagramPerf);
  expect(requests.value).toBe(0);
  expect(result.started).toBeGreaterThan(0);
  expect(result.startedAtMessage).toBe(result.started);
  expect(result.longTasks).toEqual([]);
  expect(result.workerMessages).toEqual({spans: []});
});


test('ordinary measurements do not install worker recording', async({page}) => {
  await page.evaluate(() => {
    (window as any).__teagramPerf = {};
    (window as any).__teagramInstallWorkerMessageAttribution = () => { throw new Error('recorder unexpectedly installed'); };
  });
  await beginMeasurement(page, {value: 0});
  expect(await page.evaluate(() => (window as any).__teagramPerf.workerMessages)).toBeUndefined();
});
