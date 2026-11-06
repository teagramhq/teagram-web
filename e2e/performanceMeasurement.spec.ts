import {expect, test} from '@playwright/test';
import {beginMeasurement, finishIncompleteScroll, getContactsFailureDetails, getContactsRpcFailureDetails, observeFirstVisibleChatList, startMeasurementAtClick, waitForFirstVisibleBubble, waitForFirstVisibleChatList} from './performanceMeasurement';
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

test('retains the incomplete scroll error when trace cleanup fails', async() => {
  await expect(finishIncompleteScroll('scroll reached message 30, expected 20', true, async() => {
    throw new Error('trace failed');
  })).rejects.toThrow('scroll reached message 30, expected 20; frame trace cleanup failed: Error: trace failed');
  await expect(finishIncompleteScroll('scroll reached message 30, expected 20', false, async() => {})).resolves.toBeUndefined();
});

test('reports contacts container state when no contact rows appear', async({page}) => {
  await page.setContent('<div id="contacts-container"><input class="input-search-input" value="x"><ul id="contacts"></ul></div>');
  expect(await getContactsFailureDetails(page)).toEqual({
    containerCount: 1, listCount: 1, rowCount: 0, searchLength: 1
  });
});

test('reports unavailable contact diagnostics without replacing the scenario error', async({page}) => {
  await page.close();
  expect(await getContactsFailureDetails(page)).toBeNull();
  expect(await getContactsRpcFailureDetails(page)).toEqual({error: 'page unavailable'});
});

test('distinguishes a timed-out contact RPC trace from an empty trace', async({page}) => {
  await page.evaluate(() => {
    (window as any).rootScope = {managers: {apiManager: {getPerformanceRpcTrace: () => new Promise(() => {})}}};
  });
  expect(await getContactsRpcFailureDetails(page)).toEqual({timedOut: true});
  await page.evaluate(() => {
    (window as any).rootScope.managers.apiManager.getPerformanceRpcTrace = () => Promise.resolve({calls: []});
  });
  expect(await getContactsRpcFailureDetails(page)).toEqual([]);
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

test('records the first visible chat-list row from the startup observer', async({page}) => {
  expect(typeof observeFirstVisibleChatList).toBe('function');
  await page.setContent('<div id="page-chats"><div id="chatlist-container"></div><div id="folders-container"></div></div>');
  await page.evaluate(() => {
    (window as any).__teagramPerf = {started: performance.now()};
  });
  await page.evaluate(observeFirstVisibleChatList);
  await page.waitForTimeout(30);
  await page.evaluate(() => {
    const snapshot = document.createElement('div');
    snapshot.className = 'chat-page-snapshot';
    const row = document.createElement('a');
    row.className = 'chatlist-chat';
    row.style.cssText = 'display:block;width:20px;height:20px';
    snapshot.append(row);
    document.getElementById('chatlist-container')?.append(snapshot);
  });
  const snapshotPaint = await waitForFirstVisibleChatList(page);
  expect(snapshotPaint.source).toBe('snapshot');
  expect(snapshotPaint.ms).toBeGreaterThanOrEqual(0);
  expect(await page.locator('.chat-page-snapshot').count()).toBe(1);

  await page.evaluate(() => {
    document.querySelector('.chat-page-snapshot')?.remove();
    const liveRow = document.createElement('a');
    liveRow.className = 'chatlist-chat';
    liveRow.style.cssText = 'display:block;width:20px;height:20px';
    document.getElementById('folders-container')?.append(liveRow);
    (window as any).__teagramPerf.started = performance.now();
    (window as any).__teagramPerf.firstVisibleChatListBoundary = undefined;
  });
  await page.evaluate(observeFirstVisibleChatList);
  const livePaint = await waitForFirstVisibleChatList(page);
  expect(livePaint.source).toBe('live');
  expect(livePaint.ms).toBeGreaterThanOrEqual(0);
});

test('arms worker recording and starts the window before queued worker messages run', async({page}) => {
  const measurement = await import('./performanceMeasurement') as any;
  expect(typeof measurement.beginMeasurement).toBe('function');
  await page.evaluate(() => {
    const channel = new MessageChannel();
    const perf: any = (window as any).__teagramPerf = {started: -1, longTasks: [{startTime: 1}], frameIntervals: [1], frameWindows: [{startMs: 1, endMs: 2}]};
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
  expect(result.frameWindows).toEqual([]);
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
