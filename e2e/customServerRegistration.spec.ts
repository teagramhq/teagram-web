import {createPublicKey, generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect, test} from '@playwright/test';

const SERVER_HOST = 'second-server.example.test';
const INVITE_SECRET = 'test-invite-secret';
const PASSWORD = 'Teagram-Test-Password-123!';

test('registers on a second server after a failed host selection', async({page}, testInfo) => {
  const pageErrors: string[] = [];

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
    try {
      const url = new URL(route.request().url());
      if(url.origin === appOriginString && url.pathname === '/private-worker-fixture.js') {
        await route.fulfill({
          status: 200,
          contentType: 'text/javascript',
          body: 'import {captured} from "./private-worker-context.js";postMessage(captured);'
        });
      } else if(url.origin === appOriginString && url.pathname === '/private-worker-context.js') {
        await route.fulfill({
          status: 200,
          contentType: 'text/javascript',
          body: 'import {getActiveServerId,readWorkerMtprotoTarget,scopeServerDatabaseName} from "/src/config/serverContext.ts";export const captured={serverId:getActiveServerId(),commonDatabase:scopeServerDatabaseName("tweb-common"),target:readWorkerMtprotoTarget()};'
        });
      } else if(url.origin === appOriginString) {
        url.protocol = 'http:';
        url.hostname = 'localhost';
        const response = await route.fetch({url: url.toString(), maxRetries: 1});
        if(url.pathname === '/') {
          const headers = await response.headers();
          headers['content-security-policy'] = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:";
          await route.fulfill({response, headers});
        } else {
          await route.fulfill({response});
        }
      } else if(url.hostname === SERVER_HOST && url.pathname === '/.well-known/teagramd/client') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: {'Access-Control-Allow-Origin': '*'},
          body: discovery
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
    if((url.hostname === SERVER_HOST && url.pathname === '/apiws') || url.hostname === 'web.teagram.io') return;
    socket.close();
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
        const user = {_ : 'user', id: 8282, username: 'second_server_user'};

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

  await page.goto(`${appOriginString}/?noWorker=1&noServiceWorker=1`, {waitUntil: 'domcontentloaded'});
  expect(await page.evaluate(() => isSecureContext && !!crypto.subtle)).toBe(true);

  const hostInput = page.getByRole('textbox', {name: 'Server address'});
  await expect(hostInput).toHaveValue('', {timeout: 30_000});
  await expect(page.locator('.input-field-placeholder')).toHaveText('your.server.host');
  await expect(page.getByRole('button', {name: 'Continue', exact: true})).toBeVisible();

  const workerContext = await page.evaluate(async({helperUrl, workerUrl, serverId, target}) => {
    const {createPrivateWorkerBlobURL} = await import(helperUrl);
    const blobUrl = await createPrivateWorkerBlobURL(workerUrl, serverId, target);
    return await new Promise((resolve, reject) => {
      const worker = new Worker(blobUrl, {type: 'module'});
      const timeout = setTimeout(() => {
        worker.terminate();
        URL.revokeObjectURL(blobUrl);
        reject(new Error('private worker did not report its startup context'));
      }, 10_000);
      worker.addEventListener('message', (event) => {
        clearTimeout(timeout);
        worker.terminate();
        URL.revokeObjectURL(blobUrl);
        resolve(event.data);
      }, {once: true});
      worker.addEventListener('error', (event) => {
        clearTimeout(timeout);
        worker.terminate();
        URL.revokeObjectURL(blobUrl);
        reject(new Error(event.message));
      }, {once: true});
    });
  }, {
    helperUrl: `${appOriginString}/src/helpers/createPrivateWorkerBlobURL.ts`,
    workerUrl: `${appOriginString}/private-worker-fixture.js`,
    serverId: 'custom-' + 'b'.repeat(64),
    target: {mode: 'private', endpoint: `wss://${SERVER_HOST}:2443/apiws`}
  });
  expect(workerContext).toEqual({
    serverId: 'custom-' + 'b'.repeat(64),
    commonDatabase: 'tweb-custom-' + 'b'.repeat(64) + '-common',
    target: {mode: 'private', endpoint: `wss://${SERVER_HOST}:2443/apiws`}
  });
  await hostInput.fill('unreachable-server.example.test');
  await page.getByRole('button', {name: 'Continue', exact: true}).click();
  await expect(page.getByRole('alert')).toHaveText('Could not connect to this server. Check the address and your connection, then try again.');

  await hostInput.fill(SERVER_HOST);
  await page.getByRole('button', {name: 'Continue', exact: true}).click();

  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText(SERVER_HOST, {exact: true})).toBeVisible();
  await expect(confirm.getByText('Server fingerprint')).toBeVisible();
  await expect(confirm.getByText(/Whoever runs this server can read your messages/)).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('teagram.server-pins.v1') || '{}'))).toEqual({});
  await confirm.getByRole('button', {name: 'Confirm', exact: true}).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('teagram.server-pins.v1') || '{}')))
    .toMatchObject({[SERVER_HOST]: expect.any(Object)});
  expect(await page.evaluate(() => localStorage.getItem('teagram.active-server-id.v1')))
    .toMatch(/^custom-[0-9a-f]{64}$/);
  await expect.poll(() => page.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_HOST__ || ''), {timeout: 10_000})
    .toBe(SERVER_HOST);

  const auth = page.locator('#auth-pages');
  await expect(auth.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await expect(auth.getByRole('textbox', {name: 'Server address'})).toHaveValue(SERVER_HOST);
  await expect(auth.getByRole('button', {name: 'Create account'})).toBeVisible();
  page.on('pageerror', (error) => pageErrors.push(error.message));
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

  const self = await page.evaluate(() => (window as any).apiManagerProxy.getUser(8282));
  expect(self).toMatchObject({_: 'user', id: 8282, username: 'second_server_user'});
  expect(self.first_name).toBeUndefined();
  expect(self.last_name).toBeUndefined();
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

  await page.locator('.sidebar-tools-button').click();
  await expect.poll(async() => pageErrors.length > 0 ||
    await page.getByText('Settings', {exact: true}).isVisible().catch(() => false)
  ).toBe(true);
  expect(pageErrors).toEqual([]);
  const settingsMenuItem = page.getByText('Settings', {exact: true});
  await expect(settingsMenuItem).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('main-menu.png')});

  await settingsMenuItem.click();

  const generalSettings = page.getByText('General Settings', {exact: true});
  await expect(generalSettings).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('settings-home.png')});
  await generalSettings.click({force: true});
  const chooseAnotherServer = page.getByText('Choose another server', {exact: true});
  await expect(chooseAnotherServer).toBeVisible();
  await page.setViewportSize({width: 375, height: 812});
  await chooseAnotherServer.scrollIntoViewIfNeeded();
  await expect(chooseAnotherServer).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('general-server-settings.png')});
  const switchReload = page.waitForNavigation({waitUntil: 'domcontentloaded'});
  await chooseAnotherServer.click({force: true});
  await switchReload;
  const switchHost = page.getByRole('textbox', {name: 'Server address'});
  await expect(switchHost).toHaveValue('');
  await expect(page.locator('.input-field-placeholder')).toHaveText('your.server.host');
  expect(await page.evaluate(() => localStorage.getItem('teagram.server-choice.v1'))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('teagram.server-pins.v1') || '{}')))
    .toMatchObject({[SERVER_HOST]: expect.any(Object)});
  await page.screenshot({path: testInfo.outputPath('server-sign-in-after-switch.png')});
  await switchHost.fill(SERVER_HOST);
  await page.getByRole('button', {name: 'Continue', exact: true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});

  const activeId = await page.evaluate(() => localStorage.getItem('teagram.active-server-id.v1'));
  expect(activeId).toMatch(/^custom-[0-9a-f]{64}$/);
  await page.evaluate((id) => localStorage.setItem(`teagram-${id}:dc2_auth_key`, 'server-a-auth-key'), activeId);
  const changedKey = generateKeyPairSync('rsa', {modulusLength: 2048, publicExponent: 0x10001})
    .publicKey.export({type: 'spki', format: 'der'}).toString('base64');
  const changedDiscovery = JSON.parse(discovery);
  changedDiscovery.mtproto.rsa_spki = changedKey;
  discovery = JSON.stringify(changedDiscovery);

  await page.reload({waitUntil: 'domcontentloaded'});
  const mismatch = page.getByRole('dialog');
  await expect(mismatch.getByText('Server identity changed')).toBeVisible();
  await expect(mismatch.getByRole('button', {name: 'Continue to confirmation'})).toBeVisible();
  await expect(mismatch.getByRole('button', {name: 'Cancel', exact: true})).toBeVisible();
  await expect(mismatch.getByRole('button', {name: 'Delete server data'})).toHaveCount(0);
  await expect(mismatch.getByRole('button', {name: 'Confirm and use this server'})).toHaveCount(0);
  await mismatch.getByRole('button', {name: 'Continue to confirmation'}).click();

  const deletion = page.getByRole('dialog');
  await expect(deletion.getByText('Confirm data deletion')).toBeVisible();
  await expect(deletion.getByText(/This is the final confirmation\. Accepting permanently deletes/)).toBeVisible();
  await expect(deletion.getByText(/A guest account used here can't be recovered/)).toBeVisible();
  await deletion.getByRole('button', {name: 'Delete server data'}).click();

  const newIdentity = page.getByRole('dialog', {name: 'Confirm this server'});
  await expect(newIdentity).toBeVisible();
  await expect(newIdentity.getByText(SERVER_HOST, {exact: true})).toBeVisible();
  await expect(newIdentity.getByText('Server fingerprint')).toBeVisible();
  await newIdentity.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(await page.evaluate(() => localStorage.getItem('teagram.active-server-id.v1'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('teagram.server-choice.v1'))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('teagram.server-pins.v1') || '{}'))).toEqual({});
  expect(await page.evaluate(() => localStorage.getItem('teagram.server-target.v1'))).toBeNull();
  const forgottenHost = page.getByRole('textbox', {name: 'Server address'});
  await expect(forgottenHost).toHaveValue(SERVER_HOST);
  await expect(forgottenHost).not.toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', {name: 'Continue', exact: true})).toBeEnabled();
  await page.context().unrouteAll({behavior: 'ignoreErrors'});
});
