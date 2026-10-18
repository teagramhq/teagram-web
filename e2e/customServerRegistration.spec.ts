import {createPublicKey, generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect, test} from '@playwright/test';

const SERVER_HOST = 'second-server.example.test';
const INVITE_SECRET = 'test-invite-secret';
const PASSWORD = 'Teagram-Test-Password-123!';

test('registers on a second server selected from the web prompt', async({page}, testInfo) => {
  const appOrigin = new URL(testInfo.project.use.baseURL as string);
  appOrigin.hostname = 'web.teagram.io';
  appOrigin.protocol = 'https:';
  const appOriginString = appOrigin.origin;
  const publicKey = createPublicKey(readFileSync(resolve('scripts/fixtures/private-mtproto-public.pem')));
  const rsaSpki = publicKey.export({type: 'spki', format: 'der'}).toString('base64');
  let discovery = JSON.stringify({
    version: 1,
    mtproto: {endpoint: `${SERVER_HOST}:2443`, dc_id: 2, rsa_spki: rsaSpki},
    websocket: {endpoint: `wss://${SERVER_HOST}:2443/apiws`}
  });

  await page.context().route('**/*', async(route) => {
    const url = new URL(route.request().url());
    if(url.origin === appOriginString) {
      url.protocol = 'http:';
      url.hostname = 'localhost';
      const response = await route.fetch({url: url.toString()});
      await route.fulfill({response});
    } else if(url.hostname === SERVER_HOST && url.pathname === '/.well-known/telegramd/client') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {'Access-Control-Allow-Origin': '*'},
        body: discovery
      });
    } else {
      await route.abort();
    }
  });
  await page.context().routeWebSocket(/.*/, (socket) => {
    const url = new URL(socket.url());
    if(url.hostname === SERVER_HOST && url.pathname === '/apiws') {
      return;
    } else if(url.hostname === 'web.teagram.io') {
      socket.close();
    } else {
      socket.close();
    }
  });

  await page.addInitScript((registrationMode) => {
    Object.defineProperty(window, 'apiManagerProxy', {
      configurable: true,
      set(proxy: any) {
        delete (window as any).apiManagerProxy;
        (window as any).apiManagerProxy = proxy;
        const invoke = proxy.invoke.bind(proxy);
        const calls: Array<{method: string, params?: Record<string, unknown>}> =
          ((window as any).__customRegistrationCalls = []);
        const user = {_ : 'user', id: 8282, first_name: 'Local Server'};

        proxy.invoke = (type: string, payload: any, ...args: any[]) => {
          if(type === 'manager' && payload?.name === 'apiManager') {
            if(payload.method === 'getAppConfig') {
              calls.push({method: 'help.getAppConfig', params: {registration_mode: registrationMode}});
              return Promise.resolve({registration_mode: registrationMode});
            }

            if(payload.method === 'invokeApi') {
              const [method, params] = payload.args;
              calls.push({method, params});
              switch(method) {
                case 'auth.sendCode':
                  return Promise.resolve({
                    _: 'auth.sentCode',
                    phone_code_hash: 'mock-registration-code-hash',
                    type: {_ : 'auth.sentCodeTypeApp', length: 5},
                    timeout: 60
                  });
                case 'auth.signIn':
                  return Promise.resolve({_ : 'auth.authorizationSignUpRequired'});
                case 'auth.signUp':
                  return Promise.resolve({_ : 'auth.authorization', user});
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

          return invoke(type, payload, ...args);
        };
      }
    });
  }, 'invite');

  await page.goto(`${appOriginString}/?noWorker=1`, {waitUntil: 'domcontentloaded'});
  expect(await page.evaluate(() => isSecureContext && !!crypto.subtle)).toBe(true);
  const picker = page.getByRole('dialog');
  const hostInput = picker.getByRole('textbox', {name: 'Server host'});
  await expect(hostInput).toHaveValue('demo.teagram.io');
  await expect(picker.getByRole('button', {name: 'Continue'})).toBeVisible();
  await hostInput.fill(SERVER_HOST);
  await picker.getByRole('button', {name: 'Continue'}).click();

  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText(`Server: ${SERVER_HOST}`)).toBeVisible();
  await expect(confirm.getByText(/SPKI SHA-256:/)).toBeVisible();
  await expect(confirm.getByText(/operator of this server can read all non-secret chats/i)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('teagram.server-pins.v1'))).toBeNull();
  await confirm.getByRole('button', {name: 'Confirm and use this server'}).click();

  const returningPicker = page.getByRole('dialog');
  const rememberedHost = returningPicker.getByRole('textbox', {name: 'Server host'});
  await expect(rememberedHost).toHaveValue(SERVER_HOST);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('teagram.server-pins.v1') || '{}')))
    .toMatchObject({[SERVER_HOST]: expect.any(Object)});
  expect(await page.evaluate(() => localStorage.getItem('teagram.active-server-id.v1')))
    .toMatch(/^custom-[0-9a-f]{64}$/);
  await returningPicker.getByRole('button', {name: 'Continue'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_HOST__ || ''), {timeout: 10_000})
    .toBe(SERVER_HOST);

  const auth = page.locator('#auth-pages');
  await expect(auth.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await expect(auth.getByText(`Server: ${SERVER_HOST}`, {exact: true})).toBeVisible();
  await expect(auth.getByRole('button', {name: 'Create account'})).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('teagram.server-pins.v1') || '{}')))
    .toMatchObject({[SERVER_HOST]: expect.any(Object)});

  await auth.getByRole('button', {name: 'Create account'}).click();
  await auth.locator('input[aria-label="Username"]').fill('second_server_user');
  await auth.locator('input[aria-label="Display name"]').fill('Local Server');
  await auth.locator('input[aria-label="Password"]').fill(PASSWORD);
  await auth.locator('input[aria-label="Confirm password"]').fill(PASSWORD);
  await auth.locator('input[aria-label="Invite secret"]').fill(INVITE_SECRET);
  await auth.getByRole('button', {name: 'Create account'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});

  const calls = await page.evaluate(() => (window as any).__customRegistrationCalls as Array<{
    method: string,
    params?: Record<string, unknown>
  }>);
  expect(calls.map((call) => call.method).filter((method) => method.startsWith('auth.'))).toEqual([
    'auth.sendCode',
    'auth.signIn',
    'auth.signUp'
  ]);
  expect(calls.find((call) => call.method === 'auth.signUp')?.params).toMatchObject({
    phone_number: 'second_server_user',
    first_name: 'Local Server',
    last_name: ''
  });
  expect(calls.find((call) => call.method === 'auth.signIn')?.params?.phone_code).toBe(INVITE_SECRET);
  await expect.poll(() => page.evaluate(() => (window as any).apiManagerProxy.getUser(8282))).toMatchObject({
    _: 'user',
    id: 8282,
    first_name: 'Local Server'
  });

  const activeId = await page.evaluate(() => localStorage.getItem('teagram.active-server-id.v1'));
  expect(activeId).toMatch(/^custom-[0-9a-f]{64}$/);
  await page.evaluate((id) => localStorage.setItem(`teagram-${id}:dc2_auth_key`, 'server-a-auth-key'), activeId);
  const changedKey = generateKeyPairSync('rsa', {modulusLength: 2048, publicExponent: 0x10001})
    .publicKey.export({type: 'spki', format: 'der'}).toString('base64');
  const changedDiscovery = JSON.parse(discovery);
  changedDiscovery.mtproto.rsa_spki = changedKey;
  discovery = JSON.stringify(changedDiscovery);

  await page.reload({waitUntil: 'domcontentloaded'});
  const changedServerPicker = page.getByRole('dialog');
  await expect(changedServerPicker.getByRole('textbox', {name: 'Server host'})).toHaveValue(SERVER_HOST);
  await changedServerPicker.getByRole('button', {name: 'Continue'}).click();
  const mismatch = page.getByRole('dialog');
  await expect(mismatch.getByText('Server identity changed')).toBeVisible();
  await expect(mismatch.getByRole('button', {name: 'Forget this server'})).toBeVisible();
  await expect(mismatch.getByRole('button', {name: 'Confirm and use this server'})).toHaveCount(0);
  await expect(mismatch.getByRole('button', {name: 'Continue'})).toHaveCount(0);

  const forgetReload = page.waitForNavigation({waitUntil: 'domcontentloaded'});
  await mismatch.getByRole('button', {name: 'Forget this server'}).click();
  await forgetReload;
  expect(await page.evaluate(() => localStorage.getItem('teagram.active-server-id.v1'))).toBeNull();
  expect(await page.evaluate((id) => localStorage.getItem(`teagram-${id}:dc2_auth_key`), activeId)).toBeNull();
  await expect(page.getByRole('dialog').getByRole('textbox', {name: 'Server host'})).toHaveValue('demo.teagram.io');
  await page.unrouteAll({behavior: 'ignoreErrors'});
});
