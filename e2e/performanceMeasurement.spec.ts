import {expect, test} from '@playwright/test';
import {startMeasurementAtClick, waitForFirstVisibleBubble} from './performanceMeasurement';

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
