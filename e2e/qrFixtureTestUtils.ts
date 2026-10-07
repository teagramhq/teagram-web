import {BrowserContext, expect, Page} from '@playwright/test';

type QrFixtureOutcome = 'input-method-invalid' | 'network-bad-response-406' | 'token';

type QrFixtureObservations = {
  outcome: QrFixtureOutcome,
  managerCalls: string[],
  unexpectedManagerCalls: string[],
  actions: string[]
};

declare global {
  interface Window {
    qrFixture?: {
      selectOutcome(outcome: QrFixtureOutcome): void,
      setTheme(theme: 'day' | 'night'): void,
      setRevealProbeVisible(visible: boolean): void,
      completePendingToken(): void,
      inspect(): QrFixtureObservations
    },
    __qrFixtureConfinement?: {
      workerAttempts: string[],
      authStorageAccesses: number
    }
  }
}

export type TrafficLog = {
  refusedRequests: string[],
  refusedSockets: string[],
  workers: string[],
  consoleCategories: string[],
  pageErrors: string[]
};

export const trafficByContext = new WeakMap<BrowserContext, TrafficLog>();
export const BASE_MANAGER_CALLS = [
  'apiManager.getBaseDcId',
  'apiManager.getConfig',
  'apiManager.invokeApi:auth.exportLoginToken',
  'appAccountManager.initPasskeyLogin',
  'appStateManager.pushToState'
];

function makeTrafficLog(): TrafficLog {
  return {refusedRequests: [], refusedSockets: [], workers: [], consoleCategories: [], pageErrors: []};
}

function classifyPageError(error: Error) {
  const stack = error.stack || '';
  if(stack.includes('Synthetic QR fixture blocked worker')) return 'blocked-worker';
  if(stack.includes('/src/qrFixtureEntry')) return 'fixture-entry';
  if(stack.includes('/src/qrFixtureApp')) return 'fixture-app';
  if(stack.includes('/src/pages/cards/SignQRCard')) return 'qr-card';
  if(stack.includes('/src/components/languageChangeButton')) return 'language-button';
  if(stack.includes('/src/components/passkeyLoginButton')) return 'passkey-button';
  if(stack.includes('qr-code-styling')) return 'qr-code-styling';
  if(stack.includes('/src/components/mediaHeader')) return 'media-header';
  return 'other';
}

export async function installConfinement(page: Page, context: BrowserContext, baseURL: string) {
  const traffic = makeTrafficLog();
  const fixtureOrigin = new URL(baseURL).origin;
  trafficByContext.set(context, traffic);

  await context.route('**/*', async(route) => {
    const requestOrigin = new URL(route.request().url()).origin;
    if(requestOrigin === fixtureOrigin) {
      await route.continue();
      return;
    }

    traffic.refusedRequests.push('off-origin');
    await route.abort();
  });

  await context.routeWebSocket(/.*/, (socket) => {
    const url = new URL(socket.url());
    const socketOrigin = url.protocol === 'ws:' ? `http://${url.host}` :
      url.protocol === 'wss:' ? `https://${url.host}` : url.origin;
    if(socketOrigin === fixtureOrigin && url.pathname === '/') {
      socket.connectToServer();
      return;
    }

    traffic.refusedSockets.push('off-origin');
    socket.close();
  });

  page.on('worker', () => traffic.workers.push('dedicated-worker'));
  page.on('console', (message) => traffic.consoleCategories.push(message.type()));
  page.on('pageerror', (error) => traffic.pageErrors.push(classifyPageError(error)));

  await context.addInitScript(() => {
    const state = {workerAttempts: [] as string[], authStorageAccesses: 0};
    Object.defineProperty(window, '__qrFixtureConfinement', {value: state});

    const isAuthKey = (key: string) => key.startsWith('account') ||
      /^dc\d+_(auth_key|server_salt)$/.test(key) ||
      key === 'user_auth' ||
      key === 'preview_auth_seeded';

    const storagePrototype = Storage.prototype as any;
    for(const method of ['getItem', 'setItem', 'removeItem']) {
      const original = storagePrototype[method];
      storagePrototype[method] = function(...args: string[]) {
        if(isAuthKey(String(args[0]))) ++state.authStorageAccesses;
        return original.apply(this, args);
      };
    }

    const blockWorker = (kind: string) => function() {
      const stack = new Error().stack || '';
      const source = stack.includes('/src/lib/lottie/lottieLoader') ? 'lottie-loader' :
        stack.includes('/src/lib/lottie') ? 'lottie' :
        stack.includes('/src/lib/apiManagerProxy') ? 'manager-proxy' :
        stack.includes('/src/helpers/dom/previewUnfreeze') ? 'preview-bootstrap' :
        stack.includes('qr-code-styling') ? 'qr-code-styling' :
        stack.includes('/src/pages/cards/SignQRCard') ? 'qr-card' :
        stack.includes('node_modules') ? 'dependency' : 'other';
      state.workerAttempts.push(`${kind}:${source}`);
      throw new Error('Synthetic QR fixture blocked worker');
    };
    Object.defineProperty(window, 'Worker', {configurable: true, value: blockWorker('dedicated-worker')});
    Object.defineProperty(window, 'SharedWorker', {configurable: true, value: blockWorker('shared-worker')});
  });

  return traffic;
}

export async function getObservations(page: Page) {
  return page.evaluate(() => window.qrFixture?.inspect());
}

export async function waitForFixtureMount(page: Page) {
  try {
    await page.waitForFunction(() => !!document.querySelector('#qr-fixture-root[data-qr-fixture-ready="true"]') ||
      !!document.querySelector('[data-qr-fixture-error]'), undefined, {timeout: 30_000});
  } catch{
    const traffic = trafficByContext.get(page.context());
    throw new Error(`QR fixture did not reach ready or refusal state; page error categories: ${traffic?.pageErrors.join(', ') || 'none'}`);
  }
}

export async function expectNoUnexpectedCalls(page: Page, expectedCalls: string[]) {
  await expect.poll(async() => (await getObservations(page))?.managerCalls).toEqual(expectedCalls);
  const observations = await getObservations(page);
  expect(observations?.unexpectedManagerCalls).toEqual([]);
}

export async function expectNormalConfinement(page: Page, context: BrowserContext, traffic: TrafficLog) {
  expect(traffic.refusedRequests).toEqual([]);
  expect(traffic.refusedSockets).toEqual([]);
  expect(traffic.workers).toEqual([]);
  expect(await context.serviceWorkers()).toHaveLength(0);

  const browserObservations = await page.evaluate(() => window.__qrFixtureConfinement);
  expect(browserObservations?.workerAttempts).toEqual([]);
  expect(browserObservations?.authStorageAccesses).toBe(0);
  expect(traffic.pageErrors).toEqual([]);
}
