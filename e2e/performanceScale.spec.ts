import {readFileSync, writeFileSync} from 'node:fs';
import {expect, test, type Browser, type BrowserContext, type Page} from '@playwright/test';
import Icons from '../src/icons';
import {evaluatePerformance, PERFORMANCE_MEASUREMENT_VERSION, PERFORMANCE_REPEATS} from '../scripts/performance/policy.mjs';

type Fixture = {
  owner: number,
  partner: number,
  middle_date: number
};

type Scale = '1x' | '100x';
type Variant = 'base' | 'head';

type Metric = {
  ms: number,
  requests: number,
  domNodes: number,
  bundleBytes: number,
  longTasksOver50Ms: number,
  blockingTimeMs: number,
  maxLongTaskDurationMs: number,
  droppedFramePercent?: number,
  droppedFrames?: number,
  frameIntervals?: number
};

type VariantRun = {
  variant: Variant,
  origin: string,
  storageState: Awaited<ReturnType<BrowserContext['storageState']>>
};

const scales: Scale[] = ['1x', '100x'];
const fixturePaths: Record<Scale, string | undefined> = {
  '1x': process.env.PERF_FIXTURE_FILE_1X,
  '100x': process.env.PERF_FIXTURE_FILE_100X
};
const fixtures: Record<Scale, Fixture | undefined> = Object.fromEntries(scales.map((scale) => [
  scale,
  fixturePaths[scale] ? JSON.parse(readFileSync(fixturePaths[scale]!, 'utf8')) as Fixture : undefined
])) as Record<Scale, Fixture | undefined>;
const username = process.env.PERF_USERNAME;
const password = process.env.PERF_PASSWORD;
const reportPath = process.env.PERF_REPORT_PATH;
const report = {
  measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
  fixtureVersion: process.env.PERF_FIXTURE_VERSION || '',
  serverCommit: process.env.PERF_SERVER_COMMIT || '',
  fixtureServerCommit: process.env.PERF_FIXTURE_SERVER_COMMIT || '',
  requireBase: process.env.PERF_REQUIRE_BASE === 'true',
  variants: {
    base: {'1x': {}, '100x': {}},
    head: {'1x': {}, '100x': {}}
  } as Record<Variant, Record<Scale, Record<string, Partial<Metric>[]>>>
};
const preparedVariants: Record<Scale, Partial<Record<Variant, VariantRun>>> = {'1x': {}, '100x': {}};

const scenarios = ['coldChatList', 'warmChatList', 'chatOpen', 'scrollBack2k', 'dateJump', 'contactsList', 'contactSearch', 'globalSearch', 'sendMessage'];

test.afterAll(() => {
  if(reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
});

function installInstrumentation(page: Page, requestCounter: {value: number}) {
  page.on('request', (request) => {
    if(request.resourceType() !== 'websocket') ++requestCounter.value;
  });
  return page.addInitScript(() => {
    const perf: any = (window as any).__teagramPerf = {
      longTasks: [] as Array<{startTime: number, duration: number}>,
      frameIntervals: [] as number[],
      frameActive: false,
      started: 0
    };
    try {
      const observer = new PerformanceObserver((list) => {
        perf.longTasks.push(...list.getEntries().filter((entry) => entry.duration > 50).map((entry) => ({
          startTime: entry.startTime,
          duration: entry.duration
        })));
      });
      observer.observe({type: 'longtask', buffered: true});
    } catch{}
    perf.injectLongTask = (durationMs: number) => {
      const started = performance.now();
      while(performance.now() - started < durationMs) {}
      perf.injectedLongTask = {started, duration: performance.now() - started};
      return perf.injectedLongTask;
    };
    perf.startFrames = () => {
      perf.frameActive = true;
      perf.lastFrame = performance.now();
      const sampleFrame = (time: number) => {
        if(!perf.frameActive) return;
        perf.frameIntervals.push(time - perf.lastFrame);
        perf.lastFrame = time;
        requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);
    };
    perf.stopFrames = () => perf.frameActive = false;
  });
}

async function begin(page: Page, requests: {value: number}) {
  requests.value = 0;
  await page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    perf.longTasks = [];
    perf.frameIntervals = [];
    perf.started = performance.now();
    performance.clearResourceTimings();
  });
}

async function capture(page: Page, requests: {value: number}, ms: number, scroll = false): Promise<Metric> {
  await page.waitForTimeout(150);
  return page.evaluate(({ms, requests, scroll}) => {
    const perf = (window as any).__teagramPerf;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const bundleBytes = resources.filter((entry) => {
      return new URL(entry.name).origin === location.origin && /\.(js|css)(?:[?#]|$)/i.test(entry.name);
    }).reduce((total, entry) => total + entry.decodedBodySize, 0);
    const intervals = scroll ? perf.frameIntervals : [];
    const droppedFrames = intervals.reduce((total: number, interval: number) => total + Math.max(0, Math.round(interval / (1000 / 60)) - 1), 0);
    const droppedFramePercent = intervals.length ? droppedFrames / (droppedFrames + intervals.length) * 100 : 0;
    const longTasks = perf.longTasks.filter((entry: {startTime: number}) => entry.startTime >= perf.started);
    return {
      ms,
      requests,
      domNodes: document.querySelectorAll('*').length,
      bundleBytes,
      longTasksOver50Ms: longTasks.length,
      blockingTimeMs: longTasks.reduce((total: number, entry: {duration: number}) => total + entry.duration - 50, 0),
      maxLongTaskDurationMs: longTasks.reduce((max: number, entry: {duration: number}) => Math.max(max, entry.duration), 0),
      droppedFramePercent: scroll && intervals.length ? droppedFramePercent : undefined,
      droppedFrames: scroll && intervals.length ? droppedFrames : undefined,
      frameIntervals: scroll && intervals.length ? intervals.length : undefined
    };
  }, {ms, requests: requests.value, scroll});
}

async function injectedLongTask(page: Page) {
  return page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    const task = perf.injectedLongTask;
    return {
      duration: task?.duration,
      observed: task && perf.longTasks.some((entry: {startTime: number, duration: number}) => entry.startTime <= task.started && entry.startTime + entry.duration >= task.started && entry.duration > 50)
    };
  });
}

function evaluateWithNegativeSamples(key: string, samples: Metric[]) {
  expect(samples).toHaveLength(PERFORMANCE_REPEATS);
  const head = {
    ...report.variants.head,
    '100x': {
      ...report.variants.head['100x'],
      [key]: samples
    }
  };
  return evaluatePerformance({...report, variants: {...report.variants, head}});
}

async function elapsed(page: Page) {
  return page.evaluate(() => performance.now() - (window as any).__teagramPerf.started);
}

async function signIn(page: Page, origin: string) {
  await page.goto(origin, {waitUntil: 'domcontentloaded'});
  const auth = page.locator('#auth-pages');
  await expect(auth.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await auth.getByRole('textbox', {name: 'Username'}).fill(username!);
  await auth.getByRole('button', {name: 'Next'}).click();
  const passwordInput = auth.locator('input[name="notsearch_password"]');
  await expect(passwordInput).toBeVisible({timeout: 30_000});
  await passwordInput.fill(password!);
  await auth.getByRole('button', {name: 'Next'}).click();
  await expect(page.locator('#page-chats #chatlist-container .chatlist-chat').first()).toBeVisible({timeout: 120_000});
}

async function waitForChatList(page: Page) {
  await expect(page.locator('#page-chats #chatlist-container .chatlist-chat').first()).toBeVisible({timeout: 120_000});
}

async function reloadChatList(page: Page, requests: {value: number}) {
  await begin(page, requests);
  await page.reload({waitUntil: 'domcontentloaded'});
  await waitForChatList(page);
  return capture(page, requests, await elapsed(page));
}

async function openPartnerChat(page: Page, requests: {value: number}, fixture: Fixture) {
  const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
  await expect(row).toBeVisible({timeout: 60_000});
  await begin(page, requests);
  await row.click();
  await expect(page.locator('#page-chats .bubbles .bubble[data-mid]').first()).toBeVisible({timeout: 60_000});
  return capture(page, requests, await elapsed(page));
}

async function scrollBackTwoThousand(page: Page, requests: {value: number}, required: boolean) {
  const hasPendingHistory = () => page.evaluate(() => {
    const bubbles = (window as any).appImManager.chat.bubbles;
    return !!(bubbles.getHistoryTopPromise || bubbles.getHistoryBottomPromise);
  });

  await begin(page, requests);
  await page.evaluate(() => (window as any).__teagramPerf.startFrames());
  const initial = await page.evaluate(() => {
    const mids = [...document.querySelectorAll<HTMLElement>('.bubbles .bubble[data-mid]')].map((bubble) => Number(bubble.dataset.mid));
    return {min: Math.min(...mids), max: Math.max(...mids)};
  });
  const targetMid = Math.max(1, initial.max - 2_000);
  let previousMin = initial.min;
  let stagnant = 0;
  let currentMin = initial.min;
  const scrollable = page.locator('.bubbles-scrollable');
  const box = await scrollable.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  for(let attempt = 0; attempt < 120 && currentMin > targetMid; ++attempt) {
    const before = currentMin;
    const scrollTop = await scrollable.evaluate((element) => element.scrollTop);
    if(scrollTop < 2) await scrollable.evaluate((element) => element.scrollTop = 2);
    await page.mouse.wheel(0, -2_000);
    await page.waitForTimeout(120);
    currentMin = await page.evaluate(() => {
      const mids = [...document.querySelectorAll<HTMLElement>('.bubbles .bubble[data-mid]')].map((bubble) => Number(bubble.dataset.mid));
      return Math.min(...mids);
    });
    if(currentMin >= before && await hasPendingHistory()) {
      await expect.poll(hasPendingHistory, {timeout: 120_000}).toBe(false);
      currentMin = await page.evaluate(() => {
        const mids = [...document.querySelectorAll<HTMLElement>('.bubbles .bubble[data-mid]')].map((bubble) => Number(bubble.dataset.mid));
        return Math.min(...mids);
      });
    }
    stagnant = currentMin < previousMin ? 0 : stagnant + 1;
    previousMin = currentMin;
    if(stagnant >= 12) break;
  }
  await page.evaluate(() => (window as any).__teagramPerf.stopFrames());
  const scrollState = await page.evaluate(() => {
    const chat = (window as any).appImManager.chat;
    const bubbles = chat?.bubbles;
    return {
      loadedAll: bubbles?.scrollable.loadedAll,
      scrollTop: bubbles?.scrollable.scrollPosition,
      scrollHeight: bubbles?.scrollable.scrollSize,
      lastScrollDirection: bubbles?.scrollable.lastScrollDirection,
      historyTopPending: !!bubbles?.getHistoryTopPromise,
      peerId: chat?.peerId
    };
  });
  if(currentMin > targetMid) {
    if(!required) return undefined;
    throw new Error(`scroll reached message ${currentMin}, expected ${targetMid}: ${JSON.stringify(scrollState)}`);
  }
  return capture(page, requests, await elapsed(page), true);
}

async function jumpToFixtureDate(page: Page, requests: {value: number}, fixture: Fixture) {
  await begin(page, requests);
  const beforeMids = await page.locator('.bubbles .bubble[data-mid]').evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).dataset.mid)));
  const searchIcon = String.fromCharCode(parseInt(Icons.search, 16));
  await page.locator('#page-chats .chat-utils > .btn-icon').filter({hasText: searchIcon}).click();
  const calendarIcon = String.fromCharCode(parseInt(Icons.calendar, 16));
  const searchCalendar = page.locator('#page-chats .topbar-search-container .topbar-search-right-filter > .btn-icon').filter({hasText: calendarIcon});
  await expect(searchCalendar).toBeVisible();
  await searchCalendar.click();
  await expect(page.locator('.date-picker-scrollable')).toBeVisible();

  const targetDate = new Date(fixture.middle_date * 1000);
  targetDate.setHours(0, 0, 0, 0);
  const now = new Date();
  const monthDelta = (targetDate.getFullYear() - now.getFullYear()) * 12 + targetDate.getMonth() - now.getMonth();
  const nav = page.locator(monthDelta < 0 ? '.date-picker-prev' : '.date-picker-next');
  const title = page.locator('.date-picker-month-title');
  for(let step = 0; step < Math.abs(monthDelta); ++step) {
    const previousMonth = (await title.textContent())?.trim();
    await nav.click();
    await expect(title).not.toHaveText(previousMonth || '', {timeout: 5_000});
  }

  const expectedMonth = new Intl.DateTimeFormat('en-US', {month: 'long', year: 'numeric'}).format(targetDate);
  await page.waitForFunction((month) => {
    const normalize = (value: string | null) => value?.replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('.date-picker-month-section .date-picker-month-label')].some((label) => normalize(label.textContent) === month);
  }, expectedMonth, {timeout: 15_000});
  const selected = await page.evaluate(({month, day}) => {
    const normalize = (value: string | null) => value?.replace(/\s+/g, ' ').trim();
    const section = [...document.querySelectorAll<HTMLElement>('.date-picker-month-section')].find((item) => {
      return normalize(item.querySelector('.date-picker-month-label')?.textContent || null) === month;
    });
    const button = [...(section?.querySelectorAll<HTMLButtonElement>('.date-picker-month-date') || [])].find((item) => item.textContent?.trim() === String(day));
    if(!button || button.disabled) return false;
    button.click();
    return true;
  }, {month: expectedMonth, day: targetDate.getDate()});
  expect(selected).toBe(true);
  await page.getByRole('button', {name: 'Jump to Date'}).click();
  await page.waitForFunction((oldMids) => {
    const old = new Set(oldMids);
    return [...document.querySelectorAll<HTMLElement>('.bubbles .bubble[data-mid]')].some((bubble) => !old.has(Number(bubble.dataset.mid)));
  }, beforeMids, {timeout: 60_000});
  return capture(page, requests, await elapsed(page));
}

async function openContacts(page: Page, requests: {value: number}) {
  await begin(page, requests);
  await page.locator('.sidebar-tools-button').click();
  await page.getByText('Contacts', {exact: true}).last().click();
  await expect(page.locator('#contacts-container .chatlist-chat').first()).toBeVisible({timeout: 60_000});
  return capture(page, requests, await elapsed(page));
}

async function searchContacts(page: Page, requests: {value: number}, scale: Scale) {
  await begin(page, requests);
  const input = page.locator('#contacts-container .input-search-input');
  await input.fill(scale === '1x' ? 'k00099' : 'k09999');
  await expect(page.locator('#contacts-container .chatlist-chat').first()).toBeVisible({timeout: 60_000});
  await expect(page.locator('#contacts-container .chatlist-chat')).toHaveCount(1, {timeout: 60_000});
  return capture(page, requests, await elapsed(page));
}

async function globalSearch(page: Page, requests: {value: number}, scale: Scale) {
  await page.locator('#contacts-container .sidebar-close-button').click();
  await begin(page, requests);
  await page.keyboard.press('Control+f');
  const input = page.locator('#column-left .item-main .sidebar-header .input-search-input');
  await expect(input).toBeVisible();
  await input.fill(`needle ${scale === '1x' ? '5000' : '500000'}`);
  await expect(page.locator('#search-container .chatlist-chat').first()).toBeVisible({timeout: 90_000});
  return capture(page, requests, await elapsed(page));
}

async function sendMessage(page: Page, requests: {value: number}, fixture: Fixture) {
  await page.keyboard.press('Escape');
  await page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first().click();
  await expect(page.locator('#page-chats .bubbles .bubble[data-mid]').first()).toBeVisible();
  await begin(page, requests);
  const text = `web-perf-${process.env.GITHUB_RUN_ID || 'local'}-${Date.now()}`;
  const composer = page.locator('.input-message-input:not(.input-field-input-fake)[contenteditable="true"]');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.locator('#page-chats .bubbles .bubble.is-out').filter({hasText: text})).toBeVisible({timeout: 60_000});
  return capture(page, requests, await elapsed(page));
}

async function prepareVariant(browser: Browser, variant: Variant, origin: string): Promise<VariantRun> {
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1280, height: 800}});
  try {
    const page = await context.newPage();
    await signIn(page, origin);
    return {variant, origin, storageState: await context.storageState({indexedDB: true})};
  } finally {
    await context.close();
  }
}

// Both variants start from one signed-in snapshot so they share the auth key and cached client state.
function withOrigin(run: VariantRun, variant: Variant, origin: string): VariantRun {
  return {
    variant,
    origin,
    storageState: {
      ...run.storageState,
      origins: run.storageState.origins.map((entry) => entry.origin === run.origin ? {...entry, origin} : entry)
    }
  };
}

test.beforeAll(async({browser}) => {
  expect(username).toBeTruthy();
  expect(password).toBeTruthy();

  for(const scale of scales) {
    const fixture = fixtures[scale];
    expect(fixture, `${scale} fixture was not supplied`).toBeTruthy();
    expect(Number.isSafeInteger(fixture?.partner), `${scale} fixture partner is invalid`).toBe(true);
    expect(Number.isSafeInteger(fixture?.middle_date), `${scale} fixture date is invalid`).toBe(true);

    const suffix = scale.toUpperCase();
    const headOrigin = process.env[`PERF_HEAD_ORIGIN_${suffix}`];
    const baseOrigin = process.env[`PERF_BASE_ORIGIN_${suffix}`];
    expect(headOrigin, `${scale} head origin is missing`).toBeTruthy();
    if(report.requireBase) expect(baseOrigin, `${scale} base origin is missing`).toBeTruthy();

    const variants: Array<[Variant, string]> = report.requireBase ? [
      ['base', baseOrigin!],
      ['head', headOrigin!]
    ] : [['head', headOrigin!]];
    const [[firstVariant, firstOrigin]] = variants;
    const signedIn = await prepareVariant(browser, firstVariant, firstOrigin);
    for(const [variant, origin] of variants) {
      preparedVariants[scale][variant] = withOrigin(signedIn, variant, origin);
    }
  }
});

async function runVariant(browser: Browser, run: VariantRun, scale: Scale, fixture: Fixture) {
  const {variant, origin} = run;
  const measured = report.variants[variant][scale];
  for(const scenario of scenarios) measured[scenario] ||= [];

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });
  const page = await context.newPage();
  const requests = {value: 0};
  await installInstrumentation(page, requests);

  try {
    await page.goto(origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    measured.coldChatList.push(await test.step('cold chat list', async() => capture(page, requests, await elapsed(page))));
    measured.warmChatList.push(await test.step('warm chat list', () => reloadChatList(page, requests)));

    const chatOpen = await test.step('open scale fixture chat', () => openPartnerChat(page, requests, fixture));
    measured.chatOpen.push(chatOpen);
    const scroll = await test.step('scroll back 2,000 messages', () => scrollBackTwoThousand(page, requests, variant === 'head'));
    if(scroll) {
      measured.scrollBack2k.push(scroll);
    } else {
      // The base build may not reach the older history window. Its open-chat bundle is still the route baseline.
      measured.scrollBack2k.push({bundleBytes: chatOpen.bundleBytes});
    }
    // Both variants run the same scenario sequence so later scenarios start from the same page state.
    const jump = test.step('jump to fixture date', () => jumpToFixtureDate(page, requests, fixture), {timeout: 120_000});
    if(variant === 'head') {
      measured.dateJump.push(await jump);
    } else {
      // The base build may not support the date jump. Its open-chat bundle is still the route baseline.
      measured.dateJump.push(await jump.catch(() => ({bundleBytes: chatOpen.bundleBytes})));
    }
    measured.contactsList.push(await test.step('open contacts', () => openContacts(page, requests)));
    measured.contactSearch.push(await test.step('search contacts', () => searchContacts(page, requests, scale)));
    measured.globalSearch.push(await test.step('global message search', () => globalSearch(page, requests, scale)));
    measured.sendMessage.push(await test.step('send a message', () => sendMessage(page, requests, fixture)));
  } finally {
    await context.close();
  }
}

test('measures the scale fixture in interleaved base and head runs', async({browser}) => {
  expect(reportPath).toBeTruthy();

  for(const scale of scales) {
    const fixture = fixtures[scale];
    const variants: Variant[] = report.requireBase ? ['base', 'head'] : ['head'];

    for(let round = 0; round < PERFORMANCE_REPEATS; ++round) {
      const order = round % 2 === 0 ? variants : [...variants].reverse();
      for(const variant of order) {
        await test.step(`${scale} ${variant} round ${round + 1}`, () => runVariant(browser, preparedVariants[scale][variant]!, scale, fixture!));
      }
    }
  }
});

test('blocks repeated injected 100 ms main-thread stalls in cold chat list', async({browser}) => {
  test.skip(!report.requireBase, 'negative control requires same-run base measurements');
  const fixture = fixtures['100x'];
  expect(fixture, '100x fixture was not supplied').toBeTruthy();
  const preparedHead = preparedVariants['100x'].head;
  expect(preparedHead, '100x head sign-in snapshot was not prepared').toBeTruthy();

  // Each repeat loads in a fresh context, as the measured cold chat-list repeats do; a reload in one page is a warm load.
  const negativeSamples: Metric[] = [];
  for(let repeat = 0; repeat < PERFORMANCE_REPEATS; ++repeat) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: {width: 1280, height: 800},
      storageState: preparedHead!.storageState
    });
    const page = await context.newPage();
    const requests = {value: 0};
    await installInstrumentation(page, requests);
    try {
      await page.goto(preparedHead!.origin, {waitUntil: 'domcontentloaded'});
      await waitForChatList(page);
      // Script evaluated over the DevTools protocol is not reported as a long task; run the stall as a page task.
      await page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve((window as any).__teagramPerf.injectLongTask(100)), 0)));
      const negativeSample = await capture(page, requests, await elapsed(page));
      const injectedTask = await injectedLongTask(page);
      expect(negativeSample.longTasksOver50Ms).toBeGreaterThan(0);
      expect(injectedTask.duration).toBeGreaterThanOrEqual(100);
      expect(injectedTask.observed).toBe(true);
      expect(negativeSample.maxLongTaskDurationMs).toBeGreaterThanOrEqual(100);
      negativeSamples.push(negativeSample);
    } finally {
      await context.close();
    }
  }
  const baseColdSamples = report.variants.base['100x'].coldChatList;
  expect(baseColdSamples).toHaveLength(PERFORMANCE_REPEATS);
  const coldLoadEvaluation = evaluateWithNegativeSamples('coldChatList', negativeSamples);
  const coldLoadFailures = coldLoadEvaluation.blockingFailures.filter((failure) => failure.startsWith('100x coldChatList: '));
  const blockingTimes = (samples: Partial<Metric>[]) => samples.map((sample) => sample.blockingTimeMs);
  expect(coldLoadFailures.some((failure) => failure.includes('long task') || failure.includes('blocking time')), `100 ms cold-load control was not blocked: control blocking ${JSON.stringify(blockingTimes(negativeSamples))} ms vs base ${JSON.stringify(blockingTimes(baseColdSamples))} ms`).toBe(true);
});
