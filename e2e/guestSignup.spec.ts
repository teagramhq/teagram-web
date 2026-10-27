import {createPublicKey} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect, test} from '@playwright/test';
import type {Page, TestInfo} from '@playwright/test';
import {captureState} from './registrationMocks';

const SERVER_HOST = 'second-server.example.test';

async function fetchLocalAppRoute(route: import('@playwright/test').Route, url: string) {
  return route.fetch({url, maxRetries: 1});
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
          headers['content-security-policy'] = "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; worker-src 'self' blob:";
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
      if(error instanceof Error && /Test ended|disposed/i.test(error.message)) return;
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

        proxy.invoke = (type: string, payload: any, ...args: any[]) => {
          if(type === 'manager' && payload?.name === 'apiManager') {
            if(payload.method === 'getAppConfig') {
              calls.push({method: 'help.getAppConfig'});
              return Promise.resolve({registration_mode: 'closed'});
            }

            if(payload.method === 'invokeApi') {
              const [method, params] = payload.args;
              calls.push({method, params});
              if(method === 'auth.sendCode') {
                return Promise.resolve({
                  _: 'auth.sentCode',
                  phone_code_hash: 'guest-signup-code-hash',
                  type: {_ : 'auth.sentCodeTypeApp', length: 5},
                  timeout: 60
                });
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
              calls.push({method: 'apiManager.setUser'});
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

async function openSelectedServer(page: Page, testInfo: TestInfo) {
  const appOrigin = new URL(testInfo.project.use.baseURL as string);
  appOrigin.hostname = 'web.teagram.io';
  appOrigin.protocol = 'https:';
  await page.goto(`${appOrigin.origin}/?noWorker=1&noServiceWorker=1`, {waitUntil: 'domcontentloaded'});

  const picker = page.getByRole('dialog');
  const hostInput = picker.getByRole('textbox', {name: 'Server host'});
  await expect(hostInput).toHaveValue('');
  await expect(hostInput).toHaveAttribute('placeholder', 'your.server.host');
  await hostInput.fill(SERVER_HOST);
  await picker.getByRole('button', {name: 'Continue'}).click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation.getByText(`Server: ${SERVER_HOST}`)).toBeVisible();
  await confirmation.getByRole('button', {name: 'Confirm and use this server'}).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#auth-pages')).toBeAttached({timeout: 30_000});
  await expect(page.locator('#auth-pages').getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
}

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
  const turnstileSignUp = signupCalls.find((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp');
  const guestSignUp = turnstileSignUp?.params?.query as Record<string, unknown> | undefined;
  const guestUsername = guestSignUp?.phone_number as string;
  expect(guestUsername).toMatch(/^guest_[a-z2-7]{16}$/);
  expect(guestSignUp).toMatchObject({first_name: 'Guest', last_name: ''});
  expect(turnstileSignUp?.params?.token).toBe('guest-turnstile-token');
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
  }) => call.method === 'auth.signUp' || (call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp')).length || 0))
    .toBe(1);
  expect(webSocketUrls).toContain('wss://demo.teagram.io/apiws');
  expect(webSocketUrls.filter((url) => new URL(url).pathname === '/apiws').every((url) =>
    url === 'wss://demo.teagram.io/apiws')).toBe(true);

  const signupCalls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{
    method: string,
    params?: Record<string, unknown>
  }>);
  const turnstileSignUp = signupCalls.find((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp');
  const signup = turnstileSignUp?.params?.query as Record<string, unknown> | undefined;
  const guestUsername = signup?.phone_number as string;
  expect(guestUsername).toMatch(/^guest_[a-z2-7]{16}$/);
  expect(turnstileSignUp?.params?.token).toBe('guest-turnstile-token');
  expect(signupCalls.filter((call) => call.method === 'auth.signUp' || (call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp'))).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('__teagram_guest_username')))
    .toBe(guestUsername);
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  const chatList = page.locator('#chatlist-container');
  const demoGuestBanner = chatList.locator('[role="status"]');
  await expect(demoGuestBanner.getByText('Demo server: you\'re a guest.', {exact: true}))
    .toBeVisible({timeout: 30_000});
  await expect(demoGuestBanner.getByText(/Everything is wiped every week\. Use your own server at/)).toBeVisible();
  await demoGuestBanner.evaluate((element) => element.scrollIntoView({block: 'center'}));
  await expect(demoGuestBanner).toBeInViewport();
  await expect(demoGuestBanner.locator('.row-title')).toHaveCSS('z-index', '1');
  await expect(demoGuestBanner.locator('.row-subtitle')).toHaveCSS('z-index', '1');
  await expect.poll(() => page.evaluate(() => (window as any).apiManagerProxy.getUser(8282)?.username))
    .toBe(guestUsername);
  const bannerScreenshot = testInfo.outputPath('guest-chat-list-banner.png');
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({path: bannerScreenshot, fullPage: false, animations: 'disabled'});
  await testInfo.attach('guest-chat-list-banner', {path: bannerScreenshot, contentType: 'image/png'});

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
  await page.setViewportSize({width: 320, height: 720});
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
  await page.setViewportSize({width: 320, height: 720});
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
  const dialog = page.getByRole('dialog', {name: 'Terms of service'});
  await expect(dialog).toBeVisible();
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
  const mobileWidths = await page.evaluate(() => ({document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth}));
  expect(mobileWidths.document).toBeLessThanOrEqual(mobileWidths.viewport);
  const callsBeforeAccept = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string}>);
  expect(callsBeforeAccept.filter((call) => call.method === 'auth.signUp' || call.method === 'invokeWithReCaptcha')).toHaveLength(0);
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
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await captureState(page, testInfo, 'guest-terms-accepted-security-check');
  await challenge.getByRole('button', {name: 'Complete security check'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'guest-terms-accepted-main-screen');

  const calls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string, params?: Record<string, unknown>}>);
  const turnstileSignUp = calls.find((call) => call.method === 'invokeWithReCaptcha' &&
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp');
  expect(turnstileSignUp).toBeDefined();
  await page.unrouteAll({behavior: 'ignoreErrors'});
});

test('declining guest terms leaves no account and remains recoverable after reload', async({page}, testInfo) => {
  await page.setViewportSize({width: 320, height: 720});
  await setupGuestServer(page, testInfo, true, undefined, 'These are the terms for this server.');
  await openSelectedServer(page, testInfo);

  const auth = page.locator('#auth-pages');
  const guestButton = auth.getByRole('button', {name: 'Try it as a guest'});
  await guestButton.click();
  const dialog = page.getByRole('dialog', {name: 'Terms of service'});
  await expect(dialog).toBeVisible();
  await captureState(page, testInfo, 'guest-terms-before-decline');
  await page.keyboard.press('Escape');

  await expect(dialog).toBeHidden();
  await expect(auth.getByRole('status')).toHaveText('No account was created. Accept the terms to create one.');
  await expect(guestButton).toBeFocused();
  const calls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string}>);
  expect(calls.filter((call) => call.method === 'auth.signUp' || call.method === 'invokeWithReCaptcha')).toHaveLength(0);
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

  await expect(auth.getByRole('alert')).toHaveText('Unable to create your guest account. Check your connection and try again.');
  expect(termsPopupLoadFailed).toBe(true);
  await expect(auth.getByText('No account was created. Accept the terms to create one.')).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string}>);
  expect(calls.filter((call) => call.method === 'auth.signUp' || call.method === 'invokeWithReCaptcha')).toHaveLength(0);
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
  await expect(auth.locator('[role="status"]')).toContainText('Creating a guest account…', {timeout: 30_000});
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
    (call.params?.query as Record<string, unknown> | undefined)?._ === 'auth.signUp')).toHaveLength(1);
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
