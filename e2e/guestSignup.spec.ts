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

async function setupGuestServer(page: Page, testInfo: TestInfo, guestSignUp: boolean, signupErrorType?: string) {
  const appOrigin = new URL(testInfo.project.use.baseURL as string);
  appOrigin.hostname = 'web.teagram.io';
  appOrigin.protocol = 'https:';
  const appOriginString = appOrigin.origin;
  const publicKey = createPublicKey(readFileSync(resolve('scripts/fixtures/private-mtproto-public.pem')));
  const rsaSpki = publicKey.export({type: 'spki', format: 'der'}).toString('base64');
  const discovery = JSON.stringify({
    version: 1,
    mtproto: {endpoint: `${SERVER_HOST}:2443`, dc_id: 2, rsa_spki: rsaSpki},
    websocket: {endpoint: `wss://${SERVER_HOST}:2443/apiws`},
    turnstile: {site_key: 'guest-site-key'},
    demo: {guest_sign_up: guestSignUp}
  });

  await page.context().route('**/*', async(route) => {
    try {
      const url = new URL(route.request().url());
      if(url.origin === appOriginString) {
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
      } else if(url.hostname === SERVER_HOST && url.pathname === '/.well-known/telegramd/client') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: {'Access-Control-Allow-Origin': '*'},
          body: discovery
        });
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

  await page.context().routeWebSocket(/.*/, (socket) => {
    const url = new URL(socket.url());
    if(url.hostname === SERVER_HOST && url.pathname === '/apiws') return;
    socket.close();
  });

  await page.addInitScript((guestSignupErrorType) => {
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
                return Promise.resolve({_ : 'auth.authorizationSignUpRequired', terms_of_service: {}});
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
  }, signupErrorType);
}

async function openSelectedServer(page: Page, testInfo: TestInfo) {
  const appOrigin = new URL(testInfo.project.use.baseURL as string);
  appOrigin.hostname = 'web.teagram.io';
  appOrigin.protocol = 'https:';
  await page.goto(`${appOrigin.origin}/?noWorker=1&noServiceWorker=1`, {waitUntil: 'domcontentloaded'});

  const picker = page.getByRole('dialog');
  const hostInput = picker.getByRole('textbox', {name: 'Server host'});
  await expect(hostInput).toHaveValue('demo.teagram.io');
  await hostInput.fill(SERVER_HOST);
  await picker.getByRole('button', {name: 'Continue'}).click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation.getByText(`Server: ${SERVER_HOST}`)).toBeVisible();
  await confirmation.getByRole('button', {name: 'Confirm and use this server'}).click();

  const rememberedPicker = page.getByRole('dialog');
  await expect(rememberedPicker.getByRole('textbox', {name: 'Server host'})).toHaveValue(SERVER_HOST);
  await rememberedPicker.getByRole('button', {name: 'Continue'}).click();
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
  const returningPicker = page.getByRole('dialog');
  await expect(returningPicker.getByRole('textbox', {name: 'Server host'})).toHaveValue(SERVER_HOST);
  await returningPicker.getByRole('button', {name: 'Continue'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await expect.poll(() => page.evaluate(() => (window as any).apiManagerProxy.getUser(8282)?.username))
    .toBe(guestUsername);
  const returningCalls = await page.evaluate(() => (window as any).__customGuestCalls as Array<{method: string}>);
  expect(returningCalls.filter((call) => call.method === 'auth.signUp')).toHaveLength(0);
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
