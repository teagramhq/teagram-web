import {readFileSync, writeFileSync} from 'node:fs';
import {expect, test, type Browser, type BrowserContext, type Page} from '@playwright/test';
import Icons from '../src/icons';
import {COLD_CHAT_LIST_REPEATS, evaluatePerformance, PERFORMANCE_MEASUREMENT_VERSION, PERFORMANCE_REPEATS} from '../scripts/performance/policy.mjs';
import {createBundleRequestTracker, sumBundleBytes, type BundleRequestTracker} from './performanceBundleBytes';
import {summarizeCpuProfile, summarizeLongTaskWindow, summarizePerformancePhases, summarizeRpcTrace, type PerformanceCpuProfile, type PerformancePhaseSummary, type PerformanceRpcCall} from './performanceRpcTrace';

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
  rpcCallCount: number,
  rpcWallMs: number | null,
  nonRpcElapsedMs: number | null,
  rpcTraceEnabled: boolean,
  rpcSpansRecorded: boolean,
  rpcCalls: PerformanceRpcCall[],
  workerPhases?: PerformancePhaseSummary[],
  peerChangePhases?: PerformancePhaseSummary[],
  droppedFramePercent?: number,
  droppedFrames?: number,
  frameIntervals?: number
};

type VariantRun = {
  variant: Variant,
  origin: string,
  storageState: Awaited<ReturnType<BrowserContext['storageState']>>
};

type MeasurementBoundary = {
  ms: number,
  startedAtMs: number,
  domNodes: number
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
  diagnostics: {} as Record<string, Record<string, unknown>>,
  variants: {
    base: {'1x': {}, '100x': {}},
    head: {'1x': {}, '100x': {}}
  } as Record<Variant, Record<Scale, Record<string, Partial<Metric>[]>>>
};
const preparedVariants: Record<Scale, Partial<Record<Variant, VariantRun>>> = {'1x': {}, '100x': {}};
const bundleRequestTrackers = new WeakMap<Page, BundleRequestTracker>();

const scenarios = ['coldChatList', 'warmChatList', 'chatOpen', 'scrollBack2k', 'dateJump', 'contactsList', 'contactSearch', 'globalSearch', 'sendMessage'];

test.afterAll(() => {
  if(reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
});

function installInstrumentation(page: Page, requestCounter: {value: number}, origin: string, injectColdStall = false) {
  const bundleRequests = createBundleRequestTracker(new URL(origin).origin);
  bundleRequestTrackers.set(page, bundleRequests);
  page.on('request', (request) => {
    if(request.resourceType() !== 'websocket') ++requestCounter.value;
    bundleRequests.requestStarted(request);
  });
  page.on('requestfinished', (request) => bundleRequests.requestFinished(request));
  page.on('requestfailed', (request) => bundleRequests.requestFailed(request));
  return page.addInitScript((injectColdStall: boolean) => {
    performance.setResourceTimingBufferSize(1_000);
    const perf: any = (window as any).__teagramPerf = {
      longTasks: [] as Array<{startTime: number, duration: number}>,
      frameIntervals: [] as number[],
      frameActive: false,
      started: performance.now(),
      resourceUrlBaseline: [] as string[]
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
    if(injectColdStall) setTimeout(() => perf.injectLongTask(100), 0);
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
  }, injectColdStall);
}

async function waitForBundleResources(page: Page) {
  const bundleRequests = bundleRequestTrackers.get(page);
  if(!bundleRequests) throw new Error('Bundle request tracking was not installed for this page');
  await bundleRequests.waitForIdle(500, 10_000);
}

async function begin(page: Page, requests: {value: number}, recordRpcSpans = true) {
  requests.value = 0;
  await page.evaluate(async(recordSpans) => {
    await (window as any).rootScope.managers.apiManager.resetPerformanceRpcTrace(recordSpans);
    const perf = (window as any).__teagramPerf;
    perf.longTasks = [];
    perf.frameIntervals = [];
    perf.resourceUrlBaseline = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((entry) => entry.name);
    performance.clearResourceTimings();
    perf.started = performance.now();
  }, recordRpcSpans);
}

async function capture(page: Page, requests: {value: number}, boundary: MeasurementBoundary, scroll = false, includePhases = false): Promise<Metric> {
  const requestCount = requests.value;
  const countOnlyRpcCallCount = scroll ? await page.evaluate(async() => {
    const trace = await (window as any).rootScope.managers.apiManager.getPerformanceRpcTrace();
    return trace.callCount as number;
  }) : undefined;
  await page.waitForTimeout(150);
  await waitForBundleResources(page);
  const captured = await page.evaluate(async({boundary, scroll, includePhases, countOnlyRpcCallCount}) => {
    const {ms} = boundary;
    const perf = (window as any).__teagramPerf;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const resourceCaptureEndedAt = performance.now();
    const intervals = scroll ? perf.frameIntervals : [];
    const droppedFrames = intervals.reduce((total: number, interval: number) => total + Math.max(0, Math.round(interval / (1000 / 60)) - 1), 0);
    const droppedFramePercent = intervals.length ? droppedFrames / (droppedFrames + intervals.length) * 100 : 0;
    const longTasks = perf.longTasks.filter((entry: {startTime: number}) => entry.startTime >= perf.started);
    const rpcTrace = await (window as any).rootScope.managers.apiManager.getPerformanceRpcTrace() as {
      enabled: boolean,
      recording: boolean,
      callCount: number,
      invocations: Array<{method: string, startedAtEpochMs: number}>,
      calls: Array<{
        method: string,
        startedAtEpochMs: number,
        durationMs: number | null,
        outcome: 'pending' | 'success' | 'error'
      }>
    };
    const rpcInvocations = rpcTrace.invocations.filter((invocation) => {
      return invocation.startedAtEpochMs - performance.timeOrigin <= ms;
    });
    const workerPhases = includePhases ? (await (window as any).rootScope.managers.apiManager.getPerformancePhaseTrace() as Array<{name: string, startedAtEpochMs: number, durationMs: number | null, accountNumber?: number}>).map((phase) => ({
      ...phase,
      startMs: Math.max(0, phase.startedAtEpochMs - performance.timeOrigin)
    })) : undefined;
    const rpcCalls = rpcTrace.calls.map((call) => ({
      method: call.method,
      startedAtMs: Math.max(0, call.startedAtEpochMs - performance.timeOrigin),
      durationMs: call.durationMs,
      outcome: call.outcome
    })).filter((call) => call.startedAtMs <= ms);
    return {
      bundleResources: resources.map((entry) => ({
        name: entry.name,
        startTime: entry.startTime,
        decodedBodySize: entry.decodedBodySize
      })),
      origin: location.origin,
      resourceCaptureEndedAt,
      resourceUrlBaseline: perf.resourceUrlBaseline,
      longTasks,
      rpcTraceEnabled: rpcTrace.enabled,
      rpcSpansRecorded: rpcTrace.recording,
      rpcCallCount: rpcTrace.recording ? rpcInvocations.length : countOnlyRpcCallCount ?? rpcTrace.callCount,
      rpcCalls,
      workerPhases,
      droppedFramePercent: scroll && intervals.length ? droppedFramePercent : undefined,
      droppedFrames: scroll && intervals.length ? droppedFrames : undefined,
      frameIntervals: scroll && intervals.length ? intervals.length : undefined
    };
  }, {boundary, scroll, includePhases, countOnlyRpcCallCount});
  const {bundleResources, origin, resourceCaptureEndedAt, resourceUrlBaseline, longTasks, ...metrics} = captured;
  expect(metrics.rpcTraceEnabled, 'performance RPC trace flag was not enabled in the client build').toBe(true);
  const longTaskSummary = summarizeLongTaskWindow(longTasks, boundary.startedAtMs, boundary.ms);
  const rpcSummary = summarizeRpcTrace(metrics.rpcCalls as PerformanceRpcCall[], boundary.ms);
  return {
    ...metrics,
    bundleBytes: sumBundleBytes(bundleResources, origin, boundary.startedAtMs, resourceCaptureEndedAt, resourceUrlBaseline),
    ...longTaskSummary,
    ms: boundary.ms,
    requests: requestCount,
    domNodes: boundary.domNodes,
    rpcWallMs: metrics.rpcSpansRecorded ? rpcSummary.rpcWallMs : null,
    nonRpcElapsedMs: metrics.rpcSpansRecorded ? rpcSummary.nonRpcElapsedMs : null,
    workerPhases: includePhases ? summarizePerformancePhases(metrics.workerPhases || []) : undefined
  };
}

async function installPeerChangeTracing(page: Page) {
  return page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    const phases: Array<{name: string, startMs: number, durationMs: number}> = [];
    const base = performance.now();
    const wrap = (target: any, method: string, name: string) => {
      if(!target || typeof target[method] !== 'function') return;
      const original = target[method];
      target[method] = function(...args: any[]) {
        const started = performance.now();
        const finish = () => phases.push({
          name,
          startMs: started - base,
          durationMs: Number((performance.now() - started).toFixed(2))
        });
        let result: any;
        try {
          result = original.apply(this, args);
        } catch(error) {
          finish();
          throw error;
        }
        if(result && typeof result.then === 'function') {
          result.then(finish, finish);
        } else {
          finish();
        }
        return result;
      };
    };
    const chat = (window as any).appImManager?.chat;
    if(!chat) return [];
    wrap(chat, 'setPeer', 'chat.setPeer');
    wrap(chat, 'onChangePeer', 'chat.onChangePeer');
    wrap(chat, 'finishPeerChange', 'chat.finishPeerChange');
    wrap(chat.bubbles, 'setPeer', 'bubbles.setPeer');
    wrap(chat.bubbles, 'getHistory1', 'bubbles.getHistory1');
    wrap(chat.bubbles, 'performHistoryResult', 'bubbles.performHistoryResult');
    wrap(chat.bubbles, 'finishPeerChange', 'bubbles.finishPeerChange');
    wrap(chat.input, 'finishPeerChange', 'input.finishPeerChange');
    wrap(chat.topbar, 'finishPeerChange', 'topbar.finishPeerChange');
    perf.peerChangePhases = phases;
    return phases;
  });
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

function evaluateWithControlSamples(key: string, baseSamples: Metric[], headSamples: Metric[]) {
  expect(baseSamples).toHaveLength(COLD_CHAT_LIST_REPEATS);
  expect(headSamples).toHaveLength(COLD_CHAT_LIST_REPEATS);
  const base = {
    ...report.variants.base,
    '100x': {
      ...report.variants.base['100x'],
      [key]: baseSamples
    }
  };
  const head = {
    ...report.variants.head,
    '100x': {
      ...report.variants.head['100x'],
      [key]: headSamples
    }
  };
  return evaluatePerformance({...report, variants: {...report.variants, base, head}});
}

async function snapshotMeasurementBoundary(page: Page): Promise<MeasurementBoundary> {
  return page.evaluate(() => {
    const perf = (window as any).__teagramPerf;
    return {
      ms: performance.now() - perf.started,
      startedAtMs: perf.started,
      domNodes: document.querySelectorAll('*').length
    };
  });
}

async function startCpuProfile(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', {interval: 1_000});
  await session.send('Profiler.start');
  return session;
}

async function finishCpuProfile(session: Awaited<ReturnType<typeof startCpuProfile>>) {
  const {profile} = await session.send('Profiler.stop');
  await session.detach();
  return summarizeCpuProfile(profile as PerformanceCpuProfile);
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

async function waitForHistorySettled(page: Page) {
  let previousDomNodes = -1;
  let stableSamples = 0;
  await expect.poll(async() => {
    const state = await page.evaluate(() => {
      const bubbles = (window as any).appImManager.chat.bubbles;
      return {
        pending: !!(bubbles?.getHistoryTopPromise || bubbles?.getHistoryBottomPromise),
        domNodes: document.querySelectorAll('*').length
      };
    });
    stableSamples = !state.pending && state.domNodes === previousDomNodes ? stableSamples + 1 : 0;
    previousDomNodes = state.domNodes;
    return stableSamples >= 2;
  }, {timeout: 60_000, intervals: [100]}).toBe(true);
}

// Startup keeps fetching lazy chunks after the chat list paints; let them land before a scenario
// clears resource timings, or its bundle bytes depend on how far that tail got.
async function waitForAssetsSettled(page: Page) {
  await expect.poll(async() => {
    const before = await page.evaluate(() => performance.getEntriesByType('resource').length);
    await page.waitForTimeout(1_000);
    return await page.evaluate((count) => performance.getEntriesByType('resource').length === count, before);
  }, {timeout: 60_000, intervals: [0]}).toBe(true);
}

async function reloadChatList(page: Page, requests: {value: number}) {
  await begin(page, requests);
  await page.reload({waitUntil: 'domcontentloaded'});
  await waitForChatList(page);
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function openPartnerChat(page: Page, requests: {value: number}, fixture: Fixture) {
  const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
  await expect(row).toBeVisible({timeout: 60_000});
  await begin(page, requests);
  await row.click();
  await expect(page.locator('#page-chats .bubbles .bubble[data-mid]').first()).toBeVisible({timeout: 60_000});
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function scrollBackTwoThousand(page: Page, requests: {value: number}, required: boolean) {
  const hasPendingHistory = () => page.evaluate(() => {
    const bubbles = (window as any).appImManager.chat.bubbles;
    return !!(bubbles.getHistoryTopPromise || bubbles.getHistoryBottomPromise);
  });

  await begin(page, requests, false);
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
  return capture(page, requests, await snapshotMeasurementBoundary(page), true);
}

async function jumpToFixtureDate(page: Page, requests: {value: number}, fixture: Fixture, allowUnsupportedBase: boolean): Promise<Metric | undefined> {
  await begin(page, requests);
  const beforeMids = await page.locator('.bubbles .bubble[data-mid]').evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).dataset.mid)));
  const searchIcon = String.fromCharCode(parseInt(Icons.search, 16));
  await page.locator('#page-chats .chat-utils > .btn-icon').filter({hasText: searchIcon}).click();
  const calendarIcon = String.fromCharCode(parseInt(Icons.calendar, 16));
  const searchCalendar = page.locator('#page-chats .topbar-search-container .topbar-search-right-filter > .btn-icon').filter({hasText: calendarIcon});
  await expect(page.locator('#page-chats .topbar-search-container')).toBeVisible();
  if(!await searchCalendar.count()) {
    if(allowUnsupportedBase) return undefined;
    throw new Error('date-jump calendar control is missing from the head build');
  }
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
  await waitForHistorySettled(page);
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function openContacts(page: Page, requests: {value: number}) {
  await waitForBundleResources(page);
  await begin(page, requests);
  await page.locator('.sidebar-tools-button').click();
  await page.getByText('Contacts', {exact: true}).last().click();
  await expect(page.locator('#contacts-container .chatlist-chat').first()).toBeVisible({timeout: 60_000});
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function searchContacts(page: Page, requests: {value: number}, scale: Scale) {
  await begin(page, requests);
  const input = page.locator('#contacts-container .input-search-input');
  await input.fill(scale === '1x' ? 'k00099' : 'k09999');
  await expect(page.locator('#contacts-container .chatlist-chat').first()).toBeVisible({timeout: 60_000});
  await expect(page.locator('#contacts-container .chatlist-chat')).toHaveCount(1, {timeout: 60_000});
  return capture(page, requests, await snapshotMeasurementBoundary(page));
}

async function globalSearch(page: Page, requests: {value: number}, scale: Scale) {
  await page.locator('#contacts-container .sidebar-close-button').click();
  await begin(page, requests);
  await page.keyboard.press('Control+f');
  const input = page.locator('#column-left .item-main .sidebar-header .input-search-input');
  await expect(input).toBeVisible();
  await input.fill(`needle ${scale === '1x' ? '5000' : '500000'}`);
  await expect(page.locator('#search-container .chatlist-chat').first()).toBeVisible({timeout: 90_000});
  return capture(page, requests, await snapshotMeasurementBoundary(page));
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
  return capture(page, requests, await snapshotMeasurementBoundary(page));
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

async function runColdChatList(browser: Browser, run: VariantRun): Promise<Metric> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });
  try {
    const page = await context.newPage();
    const requests = {value: 0};
    await installInstrumentation(page, requests, run.origin);
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    expect(await page.evaluate(() => Number.isFinite((window as any).__teagramPerf.started))).toBe(true);
    await waitForChatList(page);
    return await capture(page, requests, await snapshotMeasurementBoundary(page));
  } finally {
    await context.close();
  }
}

async function measureColdControlWindow(browser: Browser, run: VariantRun, injectStall: boolean) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });
  const page = await context.newPage();
  const requests = {value: 0};
  await installInstrumentation(page, requests, run.origin, injectStall);

  try {
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    expect(await page.evaluate(() => Number.isFinite((window as any).__teagramPerf.started))).toBe(true);
    await waitForChatList(page);
    const sample = await capture(page, requests, await snapshotMeasurementBoundary(page));
    return {sample, injectedTask: injectStall ? await injectedLongTask(page) : undefined};
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

async function runContactScenarios(browser: Browser, run: VariantRun, scale: Scale, fixture: Fixture) {
  const measured = report.variants[run.variant][scale];
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });
  const page = await context.newPage();
  const requests = {value: 0};
  await installInstrumentation(page, requests, run.origin);

  try {
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    await waitForAssetsSettled(page);
    measured.contactsList.push(await test.step('open contacts', () => openContacts(page, requests)));
    measured.contactSearch.push(await test.step('search contacts', () => searchContacts(page, requests, scale)));
    measured.globalSearch.push(await test.step('global message search', () => globalSearch(page, requests, scale)));
    measured.sendMessage.push(await test.step('send a message', () => sendMessage(page, requests, fixture)));
  } finally {
    await context.close();
  }
}

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
  await installInstrumentation(page, requests, origin);

  try {
    await page.goto(origin, {waitUntil: 'domcontentloaded'});
    expect(await page.evaluate(() => Number.isFinite((window as any).__teagramPerf.started))).toBe(true);
    await waitForChatList(page);
    measured.coldChatList.push(await test.step('cold chat list', async() => capture(page, requests, await snapshotMeasurementBoundary(page))));
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
    const jump = await test.step('jump to fixture date', () => jumpToFixtureDate(page, requests, fixture, variant === 'base'), {timeout: 120_000});
    if(jump) {
      measured.dateJump.push(jump);
    } else {
      // The base build may lack the calendar control. Its open-chat bundle is still the route baseline.
      measured.dateJump.push({bundleBytes: chatOpen.bundleBytes});
    }
  } finally {
    await context.close();
  }

  // Keep contacts measurements independent of assets cached by chat and calendar scenarios.
  await runContactScenarios(browser, run, scale, fixture);
}

async function traceTargetScenarios(browser: Browser, run: VariantRun, fixture: Fixture) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800},
    storageState: run.storageState
  });
  const page = await context.newPage();
  const requests = {value: 0};
  await installInstrumentation(page, requests, run.origin);

  try {
    const coldProfile = await startCpuProfile(page);
    await page.goto(run.origin, {waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    const coldBoundary = await snapshotMeasurementBoundary(page);
    const coldCpu = await finishCpuProfile(coldProfile);
    const coldChatList = {...await capture(page, requests, coldBoundary, false, true), cpu: coldCpu};

    await begin(page, requests);
    await page.evaluate(() => (window as any).rootScope.managers.apiManager.resetPerformancePhaseTrace());
    const warmProfile = await startCpuProfile(page);
    await page.reload({waitUntil: 'domcontentloaded'});
    await waitForChatList(page);
    const warmBoundary = await snapshotMeasurementBoundary(page);
    const warmCpu = await finishCpuProfile(warmProfile);
    const warmChatList = {...await capture(page, requests, warmBoundary, false, true), cpu: warmCpu};

    const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${fixture.partner}"]`).first();
    await expect(row).toBeVisible({timeout: 60_000});
    await begin(page, requests);
    await page.evaluate(() => (window as any).rootScope.managers.apiManager.resetPerformancePhaseTrace());
    await installPeerChangeTracing(page);
    const chatProfile = await startCpuProfile(page);
    await row.click();
    await expect(page.locator('#page-chats .bubbles .bubble[data-mid]').first()).toBeVisible({timeout: 60_000});
    const chatOpenBoundary = await snapshotMeasurementBoundary(page);
    const chatCpu = await finishCpuProfile(chatProfile);
    const chatOpenCapture = await capture(page, requests, chatOpenBoundary, false, true);
    const peerChangePhases = await page.evaluate(() => (window as any).__teagramPerf.peerChangePhases || []);
    const chatOpen = {
      ...chatOpenCapture,
      cpu: chatCpu,
      peerChangePhases: summarizePerformancePhases(peerChangePhases)
    };

    return {coldChatList, warmChatList, chatOpen};
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

    for(const variant of variants) {
      const contactsBundleSizes = report.variants[variant][scale].contactsList.map((sample) => sample.bundleBytes);
      expect(new Set(contactsBundleSizes).size, `${scale} ${variant} contacts bundle measurement should be stable across repeats`).toBe(1);
    }
  }

  const coldScale: Scale = '100x';
  const coldVariants: Variant[] = report.requireBase ? ['base', 'head'] : ['head'];
  for(let repeat = PERFORMANCE_REPEATS; repeat < COLD_CHAT_LIST_REPEATS; ++repeat) {
    const order = repeat % 2 === 0 ? coldVariants : [...coldVariants].reverse();
    for(const variant of order) {
      const run = preparedVariants[coldScale][variant]!;
      const sample = await test.step(`${coldScale} ${variant} cold chat list round ${repeat + 1}`, () => runColdChatList(browser, run));
      report.variants[variant][coldScale].coldChatList.push(sample);
    }
  }
  const traceRun = preparedVariants['100x'].head;
  expect(traceRun, '100x head sign-in snapshot was not prepared').toBeTruthy();
  report.diagnostics['100x'] = await test.step('trace 100x client CPU and RPC waits', () => traceTargetScenarios(browser, traceRun!, fixtures['100x']!));
});

test('blocks repeated injected 100 ms main-thread stalls during cold chat list load', async({browser}) => {
  test.skip(!report.requireBase, 'negative control requires same-run base measurements');
  const preparedBase = preparedVariants['100x'].base;
  const preparedHead = preparedVariants['100x'].head;
  expect(preparedBase, '100x base sign-in snapshot was not prepared').toBeTruthy();
  expect(preparedHead, '100x head sign-in snapshot was not prepared').toBeTruthy();

  // Each repeat captures from document initialization so cold-start noise remains in the control window.
  const baseControlSamples: Metric[] = [];
  const negativeSamples: Metric[] = [];
  for(let repeat = 0; repeat < COLD_CHAT_LIST_REPEATS; ++repeat) {
    const order: Variant[] = repeat % 2 === 0 ? ['base', 'head'] : ['head', 'base'];
    for(const variant of order) {
      const isHead = variant === 'head';
      const run = isHead ? preparedHead! : preparedBase!;
      const {sample, injectedTask} = await measureColdControlWindow(browser, run, isHead);

      if(isHead) {
        expect(sample.longTasksOver50Ms).toBeGreaterThan(0);
        expect(injectedTask?.duration).toBeGreaterThanOrEqual(100);
        expect(injectedTask?.observed).toBe(true);
        expect(sample.maxLongTaskDurationMs).toBeGreaterThanOrEqual(100);
        negativeSamples.push(sample);
      } else {
        baseControlSamples.push(sample);
      }
    }
  }
  const coldLoadEvaluation = evaluateWithControlSamples('coldChatList', baseControlSamples, negativeSamples);
  const coldLoadFailures = coldLoadEvaluation.blockingFailures.filter((failure) => failure.startsWith('100x coldChatList: '));
  const blockingTimes = (samples: Metric[]) => samples.map((sample) => sample.blockingTimeMs);
  expect(coldLoadFailures.some((failure) => failure.includes('long task') || failure.includes('blocking time')), `100 ms control was not blocked: control blocking ${JSON.stringify(blockingTimes(negativeSamples))} ms vs same-phase base ${JSON.stringify(blockingTimes(baseControlSamples))} ms`).toBe(true);
});
