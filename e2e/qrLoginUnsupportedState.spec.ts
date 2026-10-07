import {BrowserContext, expect, Page, test} from '@playwright/test';

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
      completePendingToken(): void,
      inspect(): QrFixtureObservations
    },
    __qrFixtureConfinement?: {
      workerAttempts: string[],
      authStorageAccesses: number
    }
  }
}

type TrafficLog = {
  refusedRequests: string[],
  refusedSockets: string[],
  workers: string[],
  consoleCategories: string[],
  pageErrors: string[]
};

const trafficByContext = new WeakMap<BrowserContext, TrafficLog>();
const BASE_MANAGER_CALLS = [
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

async function installConfinement(page: Page, context: BrowserContext, baseURL: string) {
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

async function getObservations(page: Page) {
  return page.evaluate(() => window.qrFixture?.inspect());
}

async function getQrPixelDigest(page: Page) {
  return page.evaluate(async() => {
    const canvases = document.querySelectorAll<HTMLCanvasElement>('#qr-fixture-root canvas');
    const canvas = canvases[canvases.length - 1];
    const context = canvas?.getContext('2d');
    if(!canvas || !context) return undefined;

    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(pixels));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  });
}

async function getStateIconVisual(page: Page) {
  return page.locator('#qr-fixture-root [class*="qrStateIcon"]').evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--secondary-text-color)';
    document.body.appendChild(probe);
    const secondary = getComputedStyle(probe).color;
    probe.remove();
    return {
      glyph: element.textContent?.codePointAt(0),
      color: getComputedStyle(element).color,
      secondary
    };
  });
}

async function waitForFixtureMount(page: Page) {
  try {
    await page.waitForFunction(() => !!document.querySelector('#qr-fixture-root[data-qr-fixture-ready="true"]') ||
      !!document.querySelector('[data-qr-fixture-error]'), undefined, {timeout: 30_000});
  } catch{
    const traffic = trafficByContext.get(page.context());
    throw new Error(`QR fixture did not reach ready or refusal state; page error categories: ${traffic?.pageErrors.join(', ') || 'none'}`);
  }
}

async function expectNoUnexpectedCalls(page: Page, expectedCalls: string[]) {
  await expect.poll(async() => (await getObservations(page))?.managerCalls).toEqual(expectedCalls);
  const observations = await getObservations(page);
  expect(observations?.unexpectedManagerCalls).toEqual([]);
}

async function expectNormalConfinement(page: Page, context: BrowserContext, traffic: TrafficLog) {
  expect(traffic.refusedRequests).toEqual([]);
  expect(traffic.refusedSockets).toEqual([]);
  expect(traffic.workers).toEqual([]);
  expect(await context.serviceWorkers()).toHaveLength(0);

  const browserObservations = await page.evaluate(() => window.__qrFixtureConfinement);
  expect(browserObservations?.workerAttempts).toEqual([]);
  expect(browserObservations?.authStorageAccesses).toBe(0);
  expect(traffic.pageErrors).toEqual([]);
}

test.beforeEach(async({page,context}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if(typeof(baseURL) !== 'string') throw new Error('QR fixture base URL is unavailable');
  await installConfinement(page, context, baseURL);
});

for(const scenario of [
  {
    outcome: 'input-method-invalid' as const,
    expectedCalls: BASE_MANAGER_CALLS,
    title: 'QR code sign-in unavailable',
    subtitle: "This server doesn't support QR code sign-in.",
    action: 'Sign in with username',
    icon: 'ea04',
    retry: false
  },
  {
    outcome: 'network-bad-response-406' as const,
    expectedCalls: BASE_MANAGER_CALLS,
    title: 'Connection problem',
    subtitle: "The QR code couldn't be loaded. Check your connection and try again.",
    action: 'Sign in with username',
    icon: 'ea91',
    retry: true
  }
]) {
  test(`shows the safe ${scenario.outcome} state on the real QR card`, async({page,context}) => {
    const traffic = trafficByContext.get(context)!;
    await page.goto(`/qr-fixture.html?outcome=${scenario.outcome}`, {waitUntil: 'domcontentloaded'});
    await waitForFixtureMount(page);

    const mountState = await page.evaluate(() => ({
      refused: !!document.querySelector('[data-qr-fixture-error]'),
      controlReady: typeof(window.qrFixture) === 'object',
      marked: !!document.querySelector('#qr-fixture-root')?.hasAttribute('data-qr-fixture-marker')
    }));
    expect(mountState).toEqual({refused: false, controlReady: true, marked: true});
    await expect(page.locator('#qr-fixture-root')).toHaveAttribute(
      'data-qr-fixture-marker',
      'TWEB_QR_FIXTURE_DEV_ONLY_SENTINEL_6D9B42E1'
    );
    await expect(page.getByText(scenario.title, {exact: true})).toBeVisible();
    await expect(page.locator('[aria-live="polite"][aria-atomic="true"]')).toHaveText(scenario.subtitle);
    await expect(page.locator('#qr-fixture-root .preloader')).toHaveCount(0);
    await expect(page.locator('#qr-fixture-root canvas')).toHaveCount(0);
    await expect(page.locator('#qr-fixture-root [class*="qrDescription"]')).toHaveCount(0);
    const icon = page.locator('#qr-fixture-root [class*="qrStateIcon"]');
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    const lightVisual = await getStateIconVisual(page);
    expect(lightVisual.glyph).toBe(parseInt(scenario.icon, 16));
    expect(lightVisual.color).toBe(lightVisual.secondary);

    const retryButton = page.getByRole('button', {name: 'Try again', exact: true});
    const escapeButton = page.getByRole('button', {name: scenario.action, exact: true});
    const passkeyButton = page.getByRole('button', {name: /Log in by passkey/});
    if(scenario.retry) {
      await expect(retryButton).toBeVisible();
      await expect(retryButton).toHaveClass(/btn-primary btn-color-primary/);
      await expect(retryButton).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(escapeButton).toBeFocused();
    } else {
      await expect(retryButton).toHaveCount(0);
      await expect(escapeButton).toHaveClass(/btn-primary btn-color-primary/);
      await expect(escapeButton).toBeFocused();
    }

    const liveDom = await page.locator('#qr-fixture-root').evaluate((root) => [
      root.textContent || '',
      ...Array.from(root.querySelectorAll('*')).flatMap((element) =>
        Array.from(element.attributes).map((attribute) => attribute.value)
      )
    ].join('\n'));
    expect(liveDom).not.toMatch(/INPUT_METHOD_INVALID|NETWORK_BAD_RESPONSE|406|tg:\/\/login/);

    await page.keyboard.press('Tab');
    await expect(passkeyButton).toBeFocused();
    await expectNoUnexpectedCalls(page, scenario.expectedCalls);

    const observations = await getObservations(page);
    expect(observations?.outcome).toBe(scenario.outcome);

    await page.evaluate(() => window.qrFixture?.setTheme('night'));
    const darkVisual = await getStateIconVisual(page);
    expect(darkVisual.glyph).toBe(parseInt(scenario.icon, 16));
    expect(darkVisual.color).toBe(darkVisual.secondary);
    expect(darkVisual.color).not.toBe(lightVisual.color);
    await expectNoUnexpectedCalls(page, [...BASE_MANAGER_CALLS, 'apiManager.setThemeParams'].sort());

    const tileBounds = await page.locator('#qr-fixture-root [class*="qrContainer"]').boundingBox();
    expect(tileBounds).not.toBeNull();
    expect(tileBounds!.width).toBe(240);
    expect(tileBounds!.height).toBe(240);

    await page.setViewportSize({width: 320, height: 720});
    const narrowTileBounds = await page.locator('#qr-fixture-root [class*="qrContainer"]').boundingBox();
    expect(narrowTileBounds).not.toBeNull();
    expect(narrowTileBounds!.width).toBeLessThanOrEqual(240);
    expect(narrowTileBounds!.x).toBeGreaterThanOrEqual(0);
    expect(narrowTileBounds!.x + narrowTileBounds!.width).toBeLessThanOrEqual(320);
    expect(traffic.consoleCategories).not.toContain('error');
    expect(traffic.consoleCategories).toContain('warning');
    await expectNormalConfinement(page, context, traffic);
    expect(traffic.pageErrors).toEqual([]);
  });
}

test('retries only after a keyboard accessible action and restores QR loading', async({page,context}) => {
  const traffic = trafficByContext.get(context)!;
  await page.goto('/qr-fixture.html?outcome=network-bad-response-406', {waitUntil: 'domcontentloaded'});
  await waitForFixtureMount(page);
  await expect(page.getByText('Connection problem', {exact: true})).toBeVisible();
  await expect(page.locator('#qr-fixture-root .preloader')).toHaveCount(0);

  await page.evaluate(() => window.qrFixture?.selectOutcome('token'));
  const retryButton = page.getByRole('button', {name: 'Try again', exact: true});
  await expect(retryButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#qr-fixture-root .preloader')).toBeVisible();
  await expect(retryButton).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Sign in with username', exact: true})).toBeFocused();
  await page.evaluate(() => window.qrFixture?.completePendingToken());
  await expect(page.locator('#qr-fixture-root canvas')).toHaveCount(1);
  await expect(page.getByText('Log in by QR Code', {exact: true})).toBeVisible();
  await expect(page.getByText('Scan with Telegram app on your phone', {exact: true})).toBeVisible();
  await expectNoUnexpectedCalls(page, [...BASE_MANAGER_CALLS, 'timeManager.getServerTimeOffset']);
  await expectNormalConfinement(page, context, traffic);
});

test('keeps token loading controllable and the username escape keyboard accessible', async({page,context}) => {
  const traffic = trafficByContext.get(context)!;
  await page.goto('/qr-fixture.html?outcome=token', {waitUntil: 'domcontentloaded'});
  await waitForFixtureMount(page);

  await expect(page.getByText('Log in by QR Code', {exact: true})).toBeVisible();
  await expect(page.getByText('Scan with Telegram app on your phone', {exact: true})).toBeVisible();
  await expect(page.getByText('Open Telegram on your phone', {exact: true})).toBeVisible();
  await expect(page.locator('#qr-fixture-root')).toHaveAttribute(
    'data-qr-fixture-marker',
    'TWEB_QR_FIXTURE_DEV_ONLY_SENTINEL_6D9B42E1'
  );
  await expect(page.locator('#qr-fixture-root .preloader')).toBeVisible();
  const usernameEscape = page.getByRole('button', {name: 'Sign in with username', exact: true});
  await expect(usernameEscape).toBeVisible();
  await expectNoUnexpectedCalls(page, BASE_MANAGER_CALLS);

  await page.keyboard.press('Tab');
  await expect(usernameEscape).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async() => (await getObservations(page))?.actions).toContain('navigate:signIn');

  await expectNormalConfinement(page, context, traffic);
});

test('repaints the QR for the confined light and dark themes at a narrow viewport', async({page,context}) => {
  const traffic = trafficByContext.get(context)!;
  await page.goto('/qr-fixture.html?outcome=token', {waitUntil: 'domcontentloaded'});
  await waitForFixtureMount(page);

  await expect(page.locator('#qr-fixture-root')).toHaveAttribute(
    'data-qr-fixture-marker',
    'TWEB_QR_FIXTURE_DEV_ONLY_SENTINEL_6D9B42E1'
  );
  await expect(page.locator('#qr-fixture-root .preloader')).toBeVisible();
  await expectNoUnexpectedCalls(page, BASE_MANAGER_CALLS);

  const lightPalette = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      background: style.getPropertyValue('--light-filled-primary-color').trim(),
      foreground: style.getPropertyValue('--primary-text-color').trim(),
      accent: style.getPropertyValue('--primary-color').trim()
    };
  });
  expect(lightPalette.background).not.toBe('');
  expect(lightPalette.foreground).not.toBe('');
  expect(lightPalette.accent).not.toBe('');

  await page.evaluate(() => window.qrFixture?.completePendingToken());
  await expect(page.locator('#qr-fixture-root canvas')).toHaveCount(1);
  await expectNoUnexpectedCalls(page, [...BASE_MANAGER_CALLS, 'timeManager.getServerTimeOffset']);
  const lightQr = await getQrPixelDigest(page);
  expect(lightQr).toMatch(/^[a-f0-9]{64}$/);

  await page.evaluate(() => window.qrFixture?.setTheme('night'));
  const darkPalette = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      background: style.getPropertyValue('--light-filled-primary-color').trim(),
      foreground: style.getPropertyValue('--primary-text-color').trim(),
      accent: style.getPropertyValue('--primary-color').trim()
    };
  });
  expect(darkPalette.background).not.toBe('');
  expect(darkPalette.foreground).not.toBe('');
  expect(darkPalette.accent).not.toBe('');
  expect(darkPalette).not.toEqual(lightPalette);
  await expectNoUnexpectedCalls(page, [
    'apiManager.getBaseDcId',
    'apiManager.getConfig',
    'apiManager.invokeApi:auth.exportLoginToken',
    'apiManager.setThemeParams',
    'appAccountManager.initPasskeyLogin',
    'appStateManager.pushToState',
    'timeManager.getServerTimeOffset'
  ]);
  await expect.poll(() => getQrPixelDigest(page)).not.toBe(lightQr);

  await page.setViewportSize({width: 480, height: 720});
  const cardBounds = await page.locator('[data-qr-fixture-cards-container]').boundingBox();
  expect(cardBounds).not.toBeNull();
  expect(cardBounds!.x).toBeGreaterThanOrEqual(0);
  expect(cardBounds!.x + cardBounds!.width).toBeLessThanOrEqual(480);
  await expectNormalConfinement(page, context, traffic);
});

test('matches the auth shell cardsContainer width constraint', async({page}) => {
  await page.goto('/qr-fixture.html?outcome=token', {waitUntil: 'domcontentloaded'});
  await waitForFixtureMount(page);

  const cardsContainer = page.locator('[data-qr-fixture-cards-container]');
  await expect(cardsContainer).toBeVisible();
  const desktopBounds = await cardsContainer.boundingBox();
  const rootFontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(desktopBounds).not.toBeNull();
  expect(Math.abs(desktopBounds!.width - 24.5 * rootFontSize)).toBeLessThan(1);

  await page.setViewportSize({width: 320, height: 720});
  const narrowBounds = await cardsContainer.boundingBox();
  expect(narrowBounds).not.toBeNull();
  expect(narrowBounds!.width).toBeLessThan(desktopBounds!.width);
  expect(narrowBounds!.x).toBeGreaterThanOrEqual(0);
  expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(320);
});

test('refuses a browser context with auth state in either storage', async({page,context}) => {
  await context.addInitScript(() => {
    localStorage.setItem('account1', 'synthetic-placeholder');
    sessionStorage.setItem('dc1_auth_key', 'synthetic-placeholder');
  });
  await page.goto('/qr-fixture.html?outcome=token', {waitUntil: 'domcontentloaded'});
  await waitForFixtureMount(page);

  await expect(page.locator('[data-qr-fixture-error]')).toHaveText('Synthetic QR fixture refused to mount');
  expect(await page.locator('#qr-fixture-root').getAttribute('data-qr-fixture-marker')).toBeNull();
  expect(await page.evaluate(() => typeof(window.qrFixture))).toBe('undefined');
});

test('records only fixed page error categories', async({page,context}) => {
  const traffic = trafficByContext.get(context)!;
  await page.goto('/qr-fixture.html?outcome=invalid', {waitUntil: 'domcontentloaded'});
  await waitForFixtureMount(page);

  await page.evaluate(() => setTimeout(() => {
    throw new Error('qr fixture privacy sentinel');
  }, 0));
  await expect.poll(() => traffic.pageErrors.length).toBe(1);
  expect(traffic.pageErrors[0] === 'other').toBe(true);
});

test('refuses unexpected network requests and WebSockets before they connect', async({page,context}) => {
  const traffic = trafficByContext.get(context)!;
  await page.goto('/qr-fixture.html?outcome=token', {waitUntil: 'domcontentloaded'});
  await waitForFixtureMount(page);
  await expect(page.locator('#qr-fixture-root .preloader')).toBeVisible();

  const attempts = await page.evaluate(async() => {
    let fetchWasBlocked = false;
    try {
      await fetch('https://example.invalid/');
    } catch{
      fetchWasBlocked = true;
    }

    const socket = new WebSocket('wss://example.invalid/');
    await new Promise<void>((resolve) => {
      socket.addEventListener('error', () => resolve(), {once: true});
      socket.addEventListener('open', () => resolve(), {once: true});
      setTimeout(resolve, 1000);
    });

    return {fetchWasBlocked, socketWasBlocked: socket.readyState !== WebSocket.OPEN};
  });

  expect(attempts).toEqual({fetchWasBlocked: true, socketWasBlocked: true});
  expect(traffic.refusedRequests).toEqual(['off-origin']);
  expect(traffic.refusedSockets).toEqual(['off-origin']);
  await expectNormalConfinement(page, context, {...traffic, refusedRequests: [], refusedSockets: []});
});
