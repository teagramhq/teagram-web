import {createPublicKey} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect, request, test} from '@playwright/test';
import type {APIRequestContext, Page, TestInfo} from '@playwright/test';
import type {MyDialogFilter} from '@lib/storages/filters';
import {captureState, seedPriorAccountUserId} from './registrationMocks';

const SERVER_HOST = 'second-server.example.test';
let localAppRequest: APIRequestContext;

test.beforeEach(async() => {
  localAppRequest = await request.newContext();
});

test.afterEach(async({page}) => {
  // setupGuestServer registers its catch-all on the context, not the page.
  await page.close();
  await page.context().unrouteAll({behavior: 'wait'});
  await localAppRequest.dispose();
});

async function fetchLocalAppRoute(route: import('@playwright/test').Route, url: string) {
  // Keep transient Vite retries independent of the browser context that owns the route.
  const headers = route.request().headers();
  delete headers.cookie;
  delete headers.host;
  return localAppRequest.fetch(url, {
    method: route.request().method(),
    headers,
    data: route.request().postDataBuffer() ?? undefined,
    maxRetries: 1
  });
}

async function applyScreenshotTheme(page: Page, themeName: 'day' | 'night') {
  await page.evaluate(async(theme) => {
    const themeModulePath = '/src/helpers/themeController.ts';
    const themeController = (await import(themeModulePath)).default;
    const isNight = theme === 'night';
    document.documentElement.classList.toggle('night', isNight);
    themeController.applyTheme(themeController.getTheme(theme));
    document.querySelector('[name="color-scheme"]')?.setAttribute('content', isNight ? 'dark' : 'light');
  }, themeName);
}

async function setupGuestServer(
  page: Page,
  testInfo: TestInfo,
  guestSignUp: unknown,
  signupErrorType?: string,
  termsText?: string,
  termsEntities?: Array<{_: string, offset: number, length: number, url?: string}>,
  autoGuest = false,
  turnstileEnabled = true,
  serverHost = SERVER_HOST,
  appHost = 'web.teagram.io',
  serverPort = 2443,
  wipeGeneration?: string
) {
  const appOrigin = new URL(testInfo.project.use.baseURL as string);
  appOrigin.hostname = appHost;
  appOrigin.protocol = 'https:';
  const appOriginString = appOrigin.origin;
  const publicKey = createPublicKey(readFileSync(resolve('scripts/fixtures/private-mtproto-public.pem')));
  const rsaSpki = publicKey.export({type: 'spki', format: 'der'}).toString('base64');
  const createDiscovery = () => JSON.stringify({
    version: 1,
    mtproto: {endpoint: `${serverHost}:${serverPort}`, dc_id: 2, rsa_spki: rsaSpki},
    websocket: {endpoint: `wss://${serverHost}${serverPort === 443 ? '' : `:${serverPort}`}/apiws`},
    ...(turnstileEnabled ? {turnstile: {site_key: 'guest-site-key'}} : {}),
    demo: {
      guest_sign_up: guestSignUp,
      ...(wipeGeneration !== undefined ? {wipe_generation: wipeGeneration} : {})
    }
  });

  await page.context().route('**/*', async(route) => {
    try {
      const url = new URL(route.request().url());
      if(url.hostname === serverHost && url.pathname === '/.well-known/teagramd/client') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: {'Access-Control-Allow-Origin': '*'},
          body: createDiscovery()
        });
        return;
      }
      if(url.origin === appOriginString) {
        if(autoGuest && url.pathname === '/teagram-config.json') {
          await route.fulfill({json: {server: serverHost, autoGuest: true}});
          return;
        }
        url.protocol = 'http:';
        url.hostname = 'localhost';
        const response = await fetchLocalAppRoute(route, url.toString());
        if(url.pathname === '/') {
          const headers = await response.headers();
          headers['content-security-policy'] = 'script-src \'self\' \'wasm-unsafe-eval\' https://challenges.cloudflare.com; worker-src \'self\' blob:';
          await route.fulfill({response, headers});
        } else {
          await route.fulfill({response});
        }
      } else if(url.hostname === 'challenges.cloudflare.com' && url.pathname === '/turnstile/v0/api.js') {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `
            window.turnstile = {
              render(container, callbacks) {
                window.__guestTurnstileActions = [...(window.__guestTurnstileActions || []), callbacks.action];
                const complete = document.createElement('button');
                complete.type = 'button';
                complete.textContent = 'Complete security check';
                complete.onclick = () => callbacks.callback('guest-turnstile-token');
                container.append(complete);
                return 'guest-test-widget';
              },
              reset() {},
              remove() {}
            };
          `
        });
      } else {
        await route.abort();
      }
    } catch(error) {
      if(error instanceof Error && (/Test ended|disposed/i.test(error.message) ||
        (/Route is already handled/i.test(error.message) && route.request().failure()))) return;
      throw error;
    }
  });

  const webSocketUrls: string[] = [];
  await page.context().routeWebSocket(/.*/, (socket) => {
    webSocketUrls.push(socket.url());
    const url = new URL(socket.url());
    if(url.hostname === serverHost && url.pathname === '/apiws') return;
    socket.close();
  });

  await page.addInitScript(({signupErrorType: guestSignupErrorType, termsText: guestTermsText, termsEntities: guestTermsEntities}) => {
    Object.defineProperty(window, 'apiManagerProxy', {
      configurable: true,
      set(proxy: any) {
        delete (window as any).apiManagerProxy;
        (window as any).apiManagerProxy = proxy;
        const invoke = proxy.invoke.bind(proxy);
        const calls: Array<{method: string, params?: Record<string, unknown>}> =
          ((window as any).__customGuestCalls = []);
        const userFor = (username: string, firstName = 'Guest') => ({
          _: 'user',
          id: 8282,
          first_name: firstName,
          username
        });
        const sentCode = {
          _: 'auth.sentCode',
          phone_code_hash: 'guest-signup-code-hash',
          type: {_ : 'auth.sentCodeTypeApp', length: 5},
          timeout: 60
        };

        proxy.invoke = (type: string, payload: any, ...args: any[]) => {
          if(type === 'manager' && payload?.name === 'apiManager') {
            if(payload.method === 'logOut') {
              localStorage.setItem('__guestManagerLogOuts', String(Number(localStorage.getItem('__guestManagerLogOuts') || 0) + 1));
            }

            if(payload.method === 'getAppConfig') {
              calls.push({method: 'help.getAppConfig'});
              return Promise.resolve({registration_mode: 'closed'});
            }

            if(payload.method === 'invokeApi') {
              const [method, params] = payload.args;
              calls.push({method, params});
              if(method === 'auth.logOut') {
                localStorage.setItem('__guestAuthLogOuts', String(Number(localStorage.getItem('__guestAuthLogOuts') || 0) + 1));
                return Promise.resolve({_ : 'auth.loggedOut'});
              }
              if(method === 'auth.sendCode') {
                return Promise.resolve(sentCode);
              }
              if(method === 'invokeWithReCaptcha' && params.query?._ === 'auth.sendCode') {
                if(guestSignupErrorType === 'RECAPTCHA_CHECK_FAILED') {
                  return Promise.reject({type: guestSignupErrorType});
                }
                return Promise.resolve(sentCode);
              }
              if(method === 'auth.signIn') {
                if(params.phone_number === localStorage.getItem('__teagram_guest_username')) {
                  return Promise.reject({type: 'SESSION_PASSWORD_NEEDED'});
                }
                return Promise.resolve({_ : 'auth.authorizationSignUpRequired', terms_of_service: guestTermsText ? {
                  _: 'help.termsOfService',
                  id: {_ : 'dataJSON', data: '{"terms":"guest"}'},
                  text: guestTermsText,
                  entities: guestTermsEntities ?? [],
                  pFlags: {popup: true}
                } : {}});
              }
              if(method === 'auth.signUp') {
                if(guestSignupErrorType) return Promise.reject({type: guestSignupErrorType});
                localStorage.setItem('__teagram_guest_username', params.phone_number);
                return new Promise((resolve) => window.setTimeout(() => resolve({
                  _: 'auth.authorization',
                  user: userFor(params.phone_number, params.first_name)
                }), 400));
              }
              if(method === 'invokeWithReCaptcha' && params.query?._ === 'auth.signUp') {
                const signup = params.query;
                if(guestSignupErrorType) return Promise.reject({type: guestSignupErrorType});
                localStorage.setItem('__teagram_guest_username', signup.phone_number);
                return new Promise((resolve) => window.setTimeout(() => resolve({
                  _: 'auth.authorization',
                  user: userFor(signup.phone_number, signup.first_name)
                }), 400));
              }
              if(method === 'auth.checkPassword') {
                return Promise.resolve({_ : 'auth.authorization', user: userFor(localStorage.getItem('__teagram_guest_username') || '')});
              }
            }

            if(payload.method === 'setUser') {
              calls.push({method: 'apiManager.setUser', params: {isNewAccount: payload.args?.[1]}});
              localStorage.setItem('__guestRegistrationCallSnapshot', JSON.stringify(calls));
              return invoke(type, payload, ...args);
            }
          }

          if(type === 'manager' && payload?.name === 'passwordManager' && payload.method === 'updateSettings') {
            calls.push({method: 'account.updatePasswordSettings', params: payload.args[0]});
            return Promise.resolve(true);
          }
          if(type === 'manager' && payload?.name === 'passwordManager' && payload.method === 'getState') {
            return Promise.resolve({hint: ''});
          }
          if(type === 'manager' && payload?.name === 'passwordManager' && payload.method === 'getInputCheckPassword') {
            return Promise.resolve({_ : 'inputCheckPasswordSRP', srp_id: '1', A: new Uint8Array([1]), M1: new Uint8Array([2])});
          }

          return invoke(type, payload, ...args);
        };
      }
    });
  }, {signupErrorType, termsText, termsEntities});

  return webSocketUrls;
}

async function openSelectedServer(page: Page, testInfo: TestInfo, accountNumber = 1) {
  const appOrigin = new URL(testInfo.project.use.baseURL as string);
  appOrigin.hostname = 'web.teagram.io';
  appOrigin.protocol = 'https:';
  const account = accountNumber === 1 ? '' : `account=${accountNumber}&`;
  await page.goto(`${appOrigin.origin}/?${account}noWorker=1&noServiceWorker=1`, {waitUntil: 'domcontentloaded'});

  const hostInput = page.getByRole('textbox', {name: 'Server address'});
  await expect(hostInput).toHaveValue('', {timeout: 30_000});
  await expect(page.locator('.input-field-placeholder')).toHaveText('your.server.host');
  await expect(page.getByRole('button', {name: 'Create account', exact: true})).toBeVisible();
  await hostInput.fill(SERVER_HOST);
  await page.getByRole('button', {name: 'Create account', exact: true}).click();
  const confirmation = page.getByRole('dialog', {name: 'Confirm this server'});
  await expect(confirmation.getByText(SERVER_HOST, {exact: true})).toBeVisible();
  await expect(confirmation.getByText('Server fingerprint')).toBeVisible();
  await expect(confirmation.getByText(/Whoever runs this server can read your messages/)).toBeVisible();
  await confirmation.getByRole('button', {name: 'Confirm', exact: true}).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#auth-pages')).toBeAttached({timeout: 30_000});
  await expect(page.locator('#auth-pages').getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
}

test('keeps a new guest signed in when the pinned server reuses a stale account ID', async({page}, testInfo) => {
  await page.setViewportSize({width: 320, height: 720});
  await seedPriorAccountUserId(page, 8282);
  await setupGuestServer(page, testInfo, true);
  await openSelectedServer(page, testInfo, 2);

  const auth = page.locator('#auth-pages');
  const guestButton = auth.getByRole('button', {name: 'Try it as a guest'});
  await expect(guestButton).toBeVisible();
  await captureState(page, testInfo, 'guest-reused-id-ready');
  await guestButton.click();
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await captureState(page, testInfo, 'guest-reused-id-challenge');
  await challenge.getByRole('button', {name: 'Complete security check'}).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('__teagram_guest_username')))
    .toMatch(/^guest_[a-z2-7]{16}$/);
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  expect(new URL(page.url()).searchParams.get('account')).toBe('2');
  expect(await page.evaluate(() => Number(localStorage.getItem('__guestManagerLogOuts') || 0))).toBe(0);
  expect(await page.evaluate(() => Number(localStorage.getItem('__guestAuthLogOuts') || 0))).toBe(0);
  const calls = await page.evaluate(() => JSON.parse(localStorage.getItem('__guestRegistrationCallSnapshot') || '[]') as Array<{method: string}>);
  expect(calls.some((call) => call.method === 'auth.logOut')).toBe(false);
  expect(calls.find((call) => call.method === 'apiManager.setUser')).toMatchObject({params: {isNewAccount: true}});
  const username = await page.evaluate(() => (window as any).apiManagerProxy.getUser(8282)?.username);
  expect(username).toMatch(/^guest_[a-z2-7]{16}$/);
  await captureState(page, testInfo, 'guest-reused-id-chat-list');

  await page.reload({waitUntil: 'domcontentloaded'});
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await expect.poll(() => page.evaluate(() => (window as any).apiManagerProxy.getUser(8282)?.username)).toBe(username);
  expect(await page.evaluate(() => Number(localStorage.getItem('__guestAuthLogOuts') || 0))).toBe(0);
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('creates a guest only when discovery advertises it and restores the same guest after reload', async({page}, testInfo) => {
  await page.setViewportSize({width: 320, height: 720});
  await setupGuestServer(page, testInfo, true);
  await openSelectedServer(page, testInfo);

  const auth = page.locator('#auth-pages');
  await expect(auth.getByRole('button', {name: 'Try it as a guest'})).toBeVisible();
  await expect(auth.getByRole('button', {name: 'Try it as a guest'})).toBeEnabled();
  await expect(auth.getByText(/wiped weekly.*clear browser data.*server operator/i)).toBeVisible();
  await captureState(page, testInfo, 'guest-signup-ready');

  const guestButton = auth.getByRole('button', {name: 'Try it as a guest'});
  await guestButton.focus();
  await expect(guestButton).toBeFocused();
  await page.keyboard.press('Enter');
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await expect(auth.getByRole('dialog')).toHaveCount(0);
  await expect(challenge.getByRole('button', {name: 'Complete security check'})).toBeVisible();
  await captureState(page, testInfo, 'guest-signup-challenge');
  await challenge.getByRole('button', {name: 'Complete security check'}).click();
  const creatingButton = auth.getByRole('button', {name: 'Creating a guest account…'});
  await expect(creatingButton).toBeDisabled();
  await expect(auth.getByRole('button', {name: 'Next'})).toBeDisabled();
  await captureState(page, testInfo, 'guest-signup-pending');
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'guest-main-screen');

  const signupCalls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{
    method: string,
    params?: Record<string, unknown>
  }>);
  const turnstileSendCode = signupCalls.find((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.sendCode');
  const guestSignUpCall = signupCalls.find((call) => call.method === 'auth.signUp');
  const guestSignUp = guestSignUpCall?.params;
  const guestUsername = guestSignUp?.phone_number as string;
  expect(guestUsername).toMatch(/^guest_[a-z2-7]{16}$/);
  expect(guestSignUp).toMatchObject({first_name: 'Guest', last_name: ''});
  expect(turnstileSendCode?.params?.token).toBe('guest-turnstile-token');
  expect(turnstileSendCode?.params?.query).toMatchObject({phone_number: guestUsername});
  expect(signupCalls.filter((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__guestTurnstileActions)).toEqual(['signup']);
  expect(signupCalls.find((call) => call.method === 'account.updatePasswordSettings')?.params)
    .toMatchObject({newPassword: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)});
  await expect.poll(() => page.evaluate(() => (window as any).apiManagerProxy.getUser(8282)?.username))
    .toBe(guestUsername);

  await page.reload({waitUntil: 'domcontentloaded'});
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await expect.poll(() => page.evaluate(() => (window as any).apiManagerProxy.getUser(8282)?.username))
    .toBe(guestUsername);
  const returningCalls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string}>);
  expect(returningCalls.filter((call) => call.method === 'auth.signUp')).toHaveLength(0);
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('creates a guest without loading Turnstile when discovery has no site key', async({page}, testInfo) => {
  const turnstileRequests: string[] = [];
  page.on('request', (request) => {
    if(request.url().includes('challenges.cloudflare.com')) turnstileRequests.push(request.url());
  });
  await setupGuestServer(page, testInfo, true, undefined, undefined, undefined, false, false);
  await openSelectedServer(page, testInfo);

  const auth = page.locator('#auth-pages');
  await auth.getByRole('button', {name: 'Try it as a guest'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await expect(auth.getByTestId('turnstile-challenge')).toHaveCount(0);
  expect(turnstileRequests).toHaveLength(0);

  const signupCalls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string}>);
  expect(signupCalls.filter((call) => call.method === 'auth.signUp')).toHaveLength(1);
  expect(signupCalls.filter((call) => call.method === 'invokeWithReCaptcha')).toHaveLength(0);
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('auto-creates one guest from runtime config without a picker and restores it after reload', async({page}, testInfo) => {
  const webSocketUrls = await setupGuestServer(page, testInfo, true, undefined, undefined, undefined, true, true, 'demo.teagram.io', 'demo.teagram.io', 443, 'week-42');
  const appOrigin = new URL(testInfo.project.use.baseURL as string);
  appOrigin.hostname = 'demo.teagram.io';
  appOrigin.protocol = 'https:';

  await page.goto(`${appOrigin.origin}/?noWorker=1&noServiceWorker=1`, {waitUntil: 'domcontentloaded'});
  const auth = page.locator('#auth-pages');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(auth.getByRole('status').filter({hasText: 'Creating a guest account…'})).toBeVisible({timeout: 30_000});
  await expect(auth.getByRole('textbox', {name: 'Username'})).toHaveCount(0);
  await expect(auth.getByText('Your guest account is wiped weekly, is lost after you sign out or clear browser data, and is visible to the server operator.'))
    .toBeVisible();
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await captureState(page, testInfo, 'guest-auto-turnstile-challenge');
  await challenge.getByRole('button', {name: 'Complete security check'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__customGuestCalls?.filter((call: {
    method: string,
    params?: Record<string, unknown>
  }) => call.method === 'auth.signUp').length || 0))
    .toBe(1);
  expect(webSocketUrls).toContain('wss://demo.teagram.io/apiws');
  expect(webSocketUrls.filter((url) => new URL(url).pathname === '/apiws').every((url) =>
    url === 'wss://demo.teagram.io/apiws')).toBe(true);

  const signupCalls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{
    method: string,
    params?: Record<string, unknown>
  }>);
  const turnstileSendCode = signupCalls.find((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.sendCode');
  const signup = signupCalls.find((call) => call.method === 'auth.signUp')?.params;
  const guestUsername = signup?.phone_number as string;
  expect(guestUsername).toMatch(/^guest_[a-z2-7]{16}$/);
  expect(turnstileSendCode?.params?.token).toBe('guest-turnstile-token');
  expect(signupCalls.filter((call) => call.method === 'auth.signUp' || (call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp'))).toHaveLength(1);
  expect(turnstileSendCode?.params?.query).toMatchObject({phone_number: guestUsername});
  await expect.poll(() => page.evaluate(() => localStorage.getItem('__teagram_guest_username')))
    .toBe(guestUsername);
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  const chatlistOverlay = page.locator('.chatlist-overlay');
  const demoGuestBanner = chatlistOverlay.locator('[role="status"]');
  await expect(demoGuestBanner.getByText('Demo server: you\'re a guest.', {exact: true}))
    .toBeVisible({timeout: 30_000});
  await expect(demoGuestBanner.getByText(/Everything is wiped every week\. Use your own server at/)).toBeVisible();
  await page.evaluate(async() => {
    const manager = (window as any).appDialogsManager;
    const settingsModulePath = '/src/stores/appSettings.ts';
    const {setAppSettingsSilent} = await import(settingsModulePath);
    setAppSettingsSilent('notifications', 'suggested', false);

    if(!manager.suggestionContainer) {
      const container = document.createElement('div');
      manager.suggestionContainer = container;
      manager.foldersOverlay.prepend(container);
      const pendingSuggestionModulePath = '/src/components/sidebarLeft/pendingSuggestion.tsx';
      const {renderPendingSuggestion} = await import(pendingSuggestionModulePath);
      renderPendingSuggestion(container);
    }

    const foldersModulePath = '/src/stores/folders.ts';
    const useFolders = (await import(foldersModulePath)).default;
    const folders = useFolders();
    const existingFilters = (folders.folderItems as Array<{filter: MyDialogFilter}>).map(({filter}) => filter);
    const allFilter = (existingFilters.find(({id}) => id === 0) || manager.managers.filtersStorage.getFilter(0)) as MyDialogFilter | undefined;
    if(!allFilter) throw new Error('Expected the real All chats folder to be available');

    const filterId = 991234;
    const localId = Math.max(...existingFilters.map(({localId}) => localId || 0), allFilter.localId || 0) + 1;
    const customFilter = {
      ...allFilter,
      id: filterId,
      localId,
      title: {...allFilter.title, text: 'Personal'}
    };
    if(!manager.filtersRendered[0]) manager.addFilter(allFilter);
    manager.addFilter(customFilter);
    await folders.hydrateFilters([allFilter, ...existingFilters.filter(({id}) => id !== 0), customFilter]);
    await manager.onFiltersLengthChange();
  });

  const notificationBanner = chatlistOverlay.locator('.row').filter({hasText: 'Never miss a message'});
  await expect(notificationBanner).toBeVisible();
  const notificationSuggestion = notificationBanner.locator('xpath=ancestor::div[contains(@class, "suggestionContainer")][1]');
  await expect(notificationSuggestion).toHaveCount(1);
  const filterTabs = chatlistOverlay.locator('#folders-tabs');
  await expect(filterTabs.getByText('Personal')).toBeVisible();
  await expect(filterTabs).toBeVisible();
  await expect(chatlistOverlay.locator('.folders-tabs-scrollable')).toBeVisible();

  const overlaps = (first: {x: number, y: number, width: number, height: number}, second: {x: number, y: number, width: number, height: number}) =>
    first.x < second.x + second.width && first.x + first.width > second.x &&
    first.y < second.y + second.height && first.y + first.height > second.y;
  for(const theme of ['day', 'night'] as const) {
    await applyScreenshotTheme(page, theme);
    for(const width of [375, 1280]) {
      await page.setViewportSize({width, height: 900});
      await expect.poll(async() => {
        const [guestBox, notificationBox, tabsBox] = await Promise.all([
          demoGuestBanner.boundingBox(),
          notificationSuggestion.boundingBox(),
          filterTabs.boundingBox()
        ]);
        return !!guestBox && !!notificationBox && !!tabsBox &&
          !overlaps(guestBox, notificationBox) &&
          guestBox.y + guestBox.height <= tabsBox.y &&
          notificationBox.y + notificationBox.height <= tabsBox.y;
      }).toBe(true);
      const [guestBox, notificationBox, tabsBox] = await Promise.all([
        demoGuestBanner.boundingBox(),
        notificationSuggestion.boundingBox(),
        filterTabs.boundingBox()
      ]);
      if(!guestBox || !notificationBox || !tabsBox) {
        throw new Error('Expected the guest banner, notification banner, and filter tabs to have layout boxes');
      }
      expect(overlaps(guestBox, notificationBox)).toBe(false);
      expect(guestBox.y + guestBox.height).toBeLessThanOrEqual(tabsBox.y);
      expect(notificationBox.y + notificationBox.height).toBeLessThanOrEqual(tabsBox.y);
      const screenshot = testInfo.outputPath(`guest-chat-list-both-${theme}-${width}.png`);
      await page.locator('#column-left').screenshot({path: screenshot, animations: 'disabled'});
      await testInfo.attach(`guest-chat-list-both-${theme}-${width}`, {path: screenshot, contentType: 'image/png'});
    }
  }

  const closeNotification = notificationBanner.locator('button');
  await expect(closeNotification.first()).toBeVisible();
  await closeNotification.first().click();
  await expect(notificationBanner).toHaveCount(0);
  await applyScreenshotTheme(page, 'day');
  for(const theme of ['day', 'night'] as const) {
    await applyScreenshotTheme(page, theme);
    for(const width of [375, 1280]) {
      await page.setViewportSize({width, height: 900});
      await expect.poll(async() => {
        const [guestBox, tabsBox] = await Promise.all([
          demoGuestBanner.boundingBox(),
          filterTabs.boundingBox()
        ]);
        return !!guestBox && !!tabsBox && guestBox.y + guestBox.height <= tabsBox.y;
      }).toBe(true);
      const [guestBoxAfterDismiss, tabsBoxAfterDismiss] = await Promise.all([
        demoGuestBanner.boundingBox(),
        filterTabs.boundingBox()
      ]);
      if(!guestBoxAfterDismiss || !tabsBoxAfterDismiss) {
        throw new Error('Expected the guest banner and filter tabs to remain in layout after the notification banner closes');
      }
      expect(guestBoxAfterDismiss.y + guestBoxAfterDismiss.height).toBeLessThanOrEqual(tabsBoxAfterDismiss.y);
      const screenshot = testInfo.outputPath(`guest-chat-list-after-dismiss-${theme}-${width}.png`);
      await page.locator('#column-left').screenshot({path: screenshot, animations: 'disabled'});
      await testInfo.attach(`guest-chat-list-after-dismiss-${theme}-${width}`, {path: screenshot, contentType: 'image/png'});
    }
  }
  await applyScreenshotTheme(page, 'day');
  await page.evaluate(() => {
    const manager = (window as any).appDialogsManager;
    manager.__guestTestOriginalUpdateContactsLength = manager.updateContactsLength;
    manager.updateContactsLength = () => Promise.resolve(0);
    manager.updateContactsLengthPromise = undefined;
    // The guest fixture leaves its initial empty placeholder waiting on contacts; regenerate it with an empty result.
    manager.chatList.parentElement.querySelector('.empty-placeholder-dialogs')?.remove();
    manager.chatList.parentElement.classList.remove('with-placeholder');
    manager.checkIfPlaceholderNeeded();
  });
  const emptyPlaceholder = page.locator('.empty-placeholder-dialogs');
  await expect(emptyPlaceholder).toHaveCount(1);
  const emptyPlaceholderHeader = emptyPlaceholder.locator('.empty-placeholder-header');
  await expect(emptyPlaceholderHeader).toHaveText('Your chats will be here');
  await expect(emptyPlaceholder.locator('.empty-placeholder-subtitle')).toHaveCount(0);
  await expect(emptyPlaceholder.locator('a[href*="telegram."]')).toHaveCount(0);
  await expect(emptyPlaceholder.locator('.empty-placeholder-dialogs-icon')).toHaveJSProperty('complete', true);
  // The guest test leaves the production list tab inactive; reveal that rendered list and its real placeholder for the evidence crop.
  const emptyPlaceholderCaptureStyle = await page.addStyleTag({content: `
    #column-left .folders-scrollable { display: block !important; }
    #column-left .empty-placeholder-dialogs { display: block !important; }
    #column-left .loading-dialog-skeleton { display: none !important; }
    #column-left .virtual-chatlist,
    #column-left .dialogs-placeholder-canvas { display: none !important; }
    #column-left .chatlist-overlay,
    #column-left #new-menu,
    .toasts-container { display: none !important; }
  `});
  await expect(emptyPlaceholder).toBeVisible();
  await expect(emptyPlaceholderHeader).toHaveText('Your chats will be here');
  for(const theme of ['day', 'night'] as const) {
    await applyScreenshotTheme(page, theme);
    for(const width of [375, 1280]) {
      await page.setViewportSize({width, height: 900});
      await emptyPlaceholder.scrollIntoViewIfNeeded();
      await expect(emptyPlaceholderHeader).toBeInViewport({ratio: 1});
      await expect(emptyPlaceholder).toBeVisible();
      const screenshot = testInfo.outputPath(`guest-chat-empty-${theme}-${width}.png`);
      await emptyPlaceholder.screenshot({path: screenshot, animations: 'disabled'});
      await testInfo.attach(`guest-chat-empty-${theme}-${width}`, {path: screenshot, contentType: 'image/png'});
    }
  }
  await emptyPlaceholderCaptureStyle.evaluate((style) => style.parentNode?.removeChild(style));
  await applyScreenshotTheme(page, 'day');
  await page.evaluate(() => {
    const manager = (window as any).appDialogsManager;
    manager.updateContactsLength = manager.__guestTestOriginalUpdateContactsLength;
    delete manager.__guestTestOriginalUpdateContactsLength;
  });
  await applyScreenshotTheme(page, 'day');
  await expect.poll(() => page.evaluate(() => (window as any).apiManagerProxy.getUser(8282)?.username))
    .toBe(guestUsername);

  await page.reload({waitUntil: 'domcontentloaded'});
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await expect.poll(() => page.evaluate(() => (window as any).apiManagerProxy.getUser(8282)?.username))
    .toBe(guestUsername);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('__teagram_guest_username')))
    .toBe(guestUsername);
  const returningCalls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{
    method: string,
    params?: Record<string, unknown>
  }> || []);
  expect(returningCalls.filter((call) => call.method === 'auth.signUp' || (call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp'))).toHaveLength(0);
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('shows an auth error and an explicit retry after automatic guest sign-up fails', async({page}, testInfo) => {
  await page.setViewportSize({width: 375, height: 812});
  await setupGuestServer(page, testInfo, true, 'NETWORK_ERROR', undefined, undefined, true, false, 'demo.teagram.io', 'demo.teagram.io', 443);
  const appOrigin = new URL(testInfo.project.use.baseURL as string);
  appOrigin.hostname = 'demo.teagram.io';
  appOrigin.protocol = 'https:';

  await page.goto(`${appOrigin.origin}/?noWorker=1&noServiceWorker=1`, {waitUntil: 'domcontentloaded'});
  const auth = page.locator('#auth-pages');
  await expect(auth.getByRole('alert')).toContainText('Unable to create your guest account. Check your connection and try again.', {timeout: 30_000});
  const retryButton = auth.getByRole('button', {name: 'Start a new guest'});
  await expect(retryButton).toBeEnabled();
  await retryButton.focus();
  await expect(retryButton).toBeFocused();
  await expect(auth.getByText('Demo server: you\'re a guest. Everything is wiped every week. Use your own server at web.teagram.io')).toBeVisible();
  await expect(auth.getByText('Your guest account is wiped weekly, is lost after you sign out or clear browser data, and is visible to the server operator.')).toBeVisible();
  await captureState(page, testInfo, 'guest-auto-signup-error');

  const signupCalls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string}>);
  expect(signupCalls.filter((call) => call.method === 'auth.signUp')).toHaveLength(1);
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('explains when the guest account context changes', async({page}, testInfo) => {
  await page.setViewportSize({width: 1280, height: 800});
  await setupGuestServer(page, testInfo, true, 'GUEST_CONTEXT_CHANGED');
  await openSelectedServer(page, testInfo);

  const auth = page.locator('#auth-pages');
  await auth.getByRole('button', {name: 'Try it as a guest'}).click();
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await challenge.getByRole('button', {name: 'Complete security check'}).click();

  const error = auth.getByRole('alert');
  await expect(error).toHaveText('Your account or server changed. Start the guest sign-in again.', {timeout: 30_000});
  await expect(error).not.toContainText('Check your connection');
  await captureState(page, testInfo, 'guest-auth-context-changed');
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('keeps non-terms focus traps on their description', async({page}, testInfo) => {
  await setupGuestServer(page, testInfo, true);
  await openSelectedServer(page, testInfo);

  await page.evaluate(async() => {
    const popupModulePath = '/src/components/popups/simpleConfirmation.ts';
    const {SimpleConfirmationPopup} = await import(popupModulePath);
    const popup = new SimpleConfirmationPopup({
      titleLangKey: 'Confirm',
      descriptionText: 'Confirm the server identity.',
      buttons: [{langKey: 'OK'}],
      focusTrap: true
    });
    (window as any).__guestFocusPopup = popup;
    popup.show(false);
  });

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.popup-description')).toBeFocused();
  await page.evaluate(() => (window as any).__guestFocusPopup.forceHide());
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('shows instance terms before guest sign-up and creates an account only after acceptance', async({page}, testInfo) => {
  const termsText = [
    'These are the terms for this server.',
    'Read each section before you create your guest account.',
    'Visit https://terms.example.test for the full terms.',
    'Contact support@example.test if you have questions.',
    'Read the Terms page online.',
    ...Array.from({length: 32}, (_, index) => `Section ${index + 1}: This server terms line keeps the document long enough to scroll.`)
  ].join('\n');
  const textUrlLabel = 'Terms page';
  await page.setViewportSize({width: 375, height: 812});
  await setupGuestServer(page, testInfo, true, undefined, termsText, [{
    _: 'messageEntityTextUrl',
    offset: termsText.indexOf(textUrlLabel),
    length: textUrlLabel.length,
    url: 'https://terms.example.test'
  }]);
  await openSelectedServer(page, testInfo);

  const auth = page.locator('#auth-pages');
  const guestButton = auth.getByRole('button', {name: 'Try it as a guest'});
  await guestButton.click();
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await challenge.getByRole('button', {name: 'Complete security check'}).click();
  const dialog = page.getByRole('dialog', {name: 'Terms of service'});
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  const termsContent = dialog.locator('.terms-content');
  await expect(termsContent).not.toBeFocused();
  for(const theme of ['day', 'night'] as const) {
    await applyScreenshotTheme(page, theme);
    for(const viewport of [{width: 375, height: 812}, {width: 1280, height: 900}]) {
      await page.setViewportSize(viewport);
      const screenshot = testInfo.outputPath(`guest-terms-${theme}-${viewport.width}.png`);
      await page.screenshot({path: screenshot, animations: 'disabled'});
      await testInfo.attach(`guest-terms-${theme}-${viewport.width}`, {path: screenshot, contentType: 'image/png'});
    }
  }
  await applyScreenshotTheme(page, 'day');
  await page.setViewportSize({width: 375, height: 812});
  await expect(dialog).toContainText('These are the terms for this server.');
  await expect.poll(async() => {
    const titleBox = await dialog.locator('.popup-title').boundingBox();
    const textBox = await dialog.locator('.terms-content').boundingBox();
    return !!titleBox && !!textBox && titleBox.y + titleBox.height <= textBox.y;
  }).toBe(true);
  const declineBox = await dialog.getByRole('button', {name: 'Decline'}).boundingBox();
  const acceptBox = await dialog.getByRole('button', {name: 'Accept'}).boundingBox();
  expect(declineBox?.x).toBeLessThan(acceptBox?.x ?? 0);
  const serverTermsLink = dialog.getByRole('link', {name: textUrlLabel});
  await expect(serverTermsLink).toHaveAttribute('href', 'https://terms.example.test');
  const bareWebLink = dialog.getByRole('link', {name: 'https://terms.example.test'});
  const emailLink = dialog.getByRole('link', {name: 'support@example.test'});
  for(const link of [serverTermsLink, bareWebLink, emailLink]) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  await expect(dialog.getByRole('button', {name: 'Decline'})).toBeVisible();
  await expect(dialog.getByRole('button', {name: 'Accept'})).toBeVisible();
  const canScroll = await page.locator('.popup-peer .scrollable-y-bordered').evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(canScroll).toBe(true);
  const termsScroller = page.locator('.popup-peer .scrollable-y-bordered');
  await termsScroller.evaluate((element) => element.scrollTop = 0);
  await page.keyboard.press('Tab');
  await expect(termsContent).toBeFocused();
  await page.keyboard.press('PageDown');
  await expect.poll(() => termsScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const mobileWidths = await page.evaluate(() => ({document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth}));
  expect(mobileWidths.document).toBeLessThanOrEqual(mobileWidths.viewport);
  const callsBeforeAccept = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string, params?: Record<string, unknown>}>);
  expect(callsBeforeAccept.filter((call) => call.method === 'auth.signUp')).toHaveLength(0);
  expect(callsBeforeAccept.filter((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp')).toHaveLength(0);
  expect(callsBeforeAccept.filter((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.sendCode')).toHaveLength(1);
  await captureState(page, testInfo, 'guest-terms-default');

  const popupBox = await dialog.locator('.popup-container').boundingBox();
  expect(popupBox?.height).toBeGreaterThan(600);
  await page.setViewportSize({width: 1280, height: 900});
  const desktopPopupBox = await dialog.locator('.popup-container').boundingBox();
  expect(desktopPopupBox?.width).toBeLessThanOrEqual(400);
  const desktopWidths = await page.evaluate(() => ({document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth}));
  expect(desktopWidths.document).toBeLessThanOrEqual(desktopWidths.viewport);
  await captureState(page, testInfo, 'guest-terms-desktop');
  await page.setViewportSize({width: 320, height: 720});
  await dialog.click({position: {x: 2, y: 2}});
  await expect(dialog).toBeVisible();
  const text = dialog.locator('.terms-content');
  const scroller = dialog.locator('.scrollable-y-bordered');
  const links = dialog.getByRole('link');
  await text.focus();
  await page.keyboard.press('PageDown');
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const popupPromise = page.waitForEvent('popup');
  await links.nth(0).focus();
  await page.keyboard.press('Enter');
  const termsTab = await popupPromise;
  await expect(dialog).toBeVisible();
  await termsTab.close();

  await text.focus();
  await page.keyboard.press('Tab');
  await expect(links.nth(0)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(links.nth(1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(links.nth(2)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', {name: 'Decline'})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', {name: 'Accept'})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(text).toBeFocused();

  await dialog.locator('.popup-description').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'guest-terms-accepted-main-screen');

  const calls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string, params?: Record<string, unknown>}>);
  const turnstileSendCode = calls.find((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.sendCode');
  expect(turnstileSendCode).toBeDefined();
  expect(calls.filter((call) => call.method === 'auth.signUp')).toHaveLength(1);
  expect(calls.filter((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__guestTurnstileActions)).toEqual(['signup']);
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('declining guest terms leaves no account and remains recoverable after reload', async({page}, testInfo) => {
  await page.setViewportSize({width: 320, height: 720});
  await setupGuestServer(page, testInfo, true, undefined, 'These are the terms for this server.');
  await openSelectedServer(page, testInfo);

  const auth = page.locator('#auth-pages');
  const guestButton = auth.getByRole('button', {name: 'Try it as a guest'});
  await guestButton.click();
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await challenge.getByRole('button', {name: 'Complete security check'}).click();
  const dialog = page.getByRole('dialog', {name: 'Terms of service'});
  await expect(dialog).toBeVisible();
  await captureState(page, testInfo, 'guest-terms-before-decline');
  await page.keyboard.press('Escape');

  await expect(dialog).toBeHidden();
  await expect(auth.getByRole('status')).toHaveText('No account was created. Accept the terms to create one.');
  await expect(guestButton).toBeFocused();
  const calls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string, params?: Record<string, unknown>}>);
  expect(calls.filter((call) => call.method === 'auth.signUp')).toHaveLength(0);
  expect(calls.filter((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp')).toHaveLength(0);
  expect(calls.filter((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.sendCode')).toHaveLength(1);
  await captureState(page, testInfo, 'guest-terms-declined');

  await page.reload({waitUntil: 'domcontentloaded'});
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const returningAuth = page.locator('#auth-pages');
  await expect(returningAuth.getByRole('button', {name: 'Try it as a guest'})).toBeVisible({timeout: 30_000});
  await expect(returningAuth.getByRole('alert')).toHaveCount(0);
  await captureState(page, testInfo, 'guest-terms-declined-after-reload');

  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('surfaces guest terms popup load failures as an auth error', async({page}, testInfo) => {
  await page.setViewportSize({width: 390, height: 844});
  await setupGuestServer(page, testInfo, true, undefined, 'These are the terms for this server.');
  await openSelectedServer(page, testInfo);

  let termsPopupLoadFailed = false;
  await page.route('**/simpleConfirmation.ts*', async(route) => {
    termsPopupLoadFailed = true;
    await route.abort();
  });

  const auth = page.locator('#auth-pages');
  await auth.getByRole('button', {name: 'Try it as a guest'}).click();
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await challenge.getByRole('button', {name: 'Complete security check'}).click();

  await expect(auth.getByRole('alert')).toHaveText('Unable to create your guest account. Check your connection and try again.');
  expect(termsPopupLoadFailed).toBe(true);
  await expect(auth.getByText('No account was created. Accept the terms to create one.')).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string, params?: Record<string, unknown>}>);
  expect(calls.filter((call) => call.method === 'auth.signUp')).toHaveLength(0);
  expect(calls.filter((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp')).toHaveLength(0);
  expect(calls.filter((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.sendCode')).toHaveLength(1);
  await captureState(page, testInfo, 'guest-terms-popup-load-error');
  await page.unroute('**/simpleConfirmation.ts*');

  await page.reload({waitUntil: 'domcontentloaded'});
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const returningAuth = page.locator('#auth-pages');
  await expect(returningAuth.getByRole('button', {name: 'Try it as a guest'})).toBeVisible({timeout: 30_000});
  await expect(returningAuth.getByRole('alert')).toHaveCount(0);
  const returningCalls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string}>);
  expect(returningCalls.filter((call) => call.method === 'auth.signUp' || call.method === 'invokeWithReCaptcha')).toHaveLength(0);
  await captureState(page, testInfo, 'guest-terms-popup-load-error-after-reload');

  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('shows one Turnstile challenge failure without retrying automatically', async({page}, testInfo) => {
  await setupGuestServer(page, testInfo, true, 'RECAPTCHA_CHECK_FAILED', undefined, undefined, true, true, 'demo.teagram.io', 'demo.teagram.io', 443);
  const appOrigin = new URL(testInfo.project.use.baseURL as string);
  appOrigin.hostname = 'demo.teagram.io';
  appOrigin.protocol = 'https:';

  await page.goto(`${appOrigin.origin}/?noWorker=1&noServiceWorker=1`, {waitUntil: 'domcontentloaded'});
  const auth = page.locator('#auth-pages');
  await expect(auth.getByRole('status').filter({hasText: 'Creating a guest account…'})).toBeVisible({timeout: 30_000});
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await challenge.getByRole('button', {name: 'Complete security check'}).click();
  await expect(auth.getByRole('alert')).toContainText('The security check failed. Try again.');
  await expect(auth.getByRole('button', {name: 'Start a new guest'})).toBeEnabled();
  const calls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{
    method: string,
    params?: Record<string, unknown>
  }>);
  expect(calls.filter((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.sendCode')).toHaveLength(1);
  await captureState(page, testInfo, 'guest-auto-turnstile-failure');
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('hides guest sign-up when the validated discovery flag is false', async({page}, testInfo) => {
  await page.setViewportSize({width: 320, height: 720});
  await setupGuestServer(page, testInfo, false);
  await openSelectedServer(page, testInfo);

  const auth = page.locator('#auth-pages');
  await expect(auth.getByRole('button', {name: 'Try it as a guest'})).toHaveCount(0);
  await expect(auth.getByText(/wiped weekly|server operator/i)).toHaveCount(0);
  await expect(auth.getByRole('button', {name: 'Next'})).toBeVisible();
  const width = await page.evaluate(() => ({document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth}));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
  await captureState(page, testInfo, 'guest-signup-unflagged');
  await page.setViewportSize({width: 1280, height: 720});
  const desktopWidth = await page.evaluate(() => ({document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth}));
  expect(desktopWidth.document).toBeLessThanOrEqual(desktopWidth.viewport);
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('shows a recoverable flood wait error after guest creation is rate limited', async({page}, testInfo) => {
  await page.setViewportSize({width: 390, height: 844});
  await setupGuestServer(page, testInfo, true, 'FLOOD_WAIT_60');
  await openSelectedServer(page, testInfo);

  const auth = page.locator('#auth-pages');
  await auth.getByRole('button', {name: 'Try it as a guest'}).click();
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge.getByRole('button', {name: 'Complete security check'})).toBeVisible();
  await challenge.getByRole('button', {name: 'Complete security check'}).click();
  const alert = auth.getByRole('alert');
  await expect(alert).toContainText('Guest sign-up is temporarily limited for this network. Try again in');
  await expect(auth.getByRole('button', {name: 'Try it as a guest'})).toBeEnabled();
  await captureState(page, testInfo, 'guest-signup-flood-wait');
  await page.unrouteAll({behavior: 'ignoreErrors'});
});
