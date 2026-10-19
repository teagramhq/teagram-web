import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:https';
import {expect, test} from '@playwright/test';
import {WebSocket, WebSocketServer} from 'ws';

const SERVER_HOST = 'second-server.example.test';
const SERVER_WSS_ENDPOINT = `wss://${SERVER_HOST}:18443/apiws`;
const SERVER_USER = process.env.TEAGRAM_CUSTOM_SERVER_TEST_USER || 'custom_server_user';
const SERVER_PASSWORD = process.env.TEAGRAM_CUSTOM_SERVER_TEST_PASSWORD || 'Teagram-Test-Password-123!';

test('signs in to a second local server through the custom server picker and worker', async({page}, testInfo) => {
  const serverHttpUrl = process.env.TEAGRAM_CUSTOM_SERVER_TEST_HTTP_URL;
  const serverWebSocketUrl = process.env.TEAGRAM_CUSTOM_SERVER_TEST_WS_URL;
  const discoveryFile = process.env.TEAGRAM_CUSTOM_SERVER_TEST_DISCOVERY_FILE;
  const hasServerFixture = !!serverHttpUrl && !!serverWebSocketUrl && !!discoveryFile;
  test.skip(!process.env.CI && !hasServerFixture, 'CI must provide the local Teagram server');
  if(!hasServerFixture) throw new Error('CI must provide the local Teagram server');

  const appBaseUrl = new URL(testInfo.project.use.baseURL as string);
  const appOrigin = new URL(appBaseUrl);
  appOrigin.protocol = 'https:';
  appOrigin.hostname = 'web.teagram.io';
  appOrigin.port = '';
  const localAppPort = appBaseUrl.port;
  const appOriginString = appOrigin.origin;
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'teagram-custom-server-ws-'));
  const privateKeyPath = join(temporaryDirectory, 'server-key.pem');
  const certificatePath = join(temporaryDirectory, 'server-cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', privateKeyPath,
    '-out', certificatePath,
    '-days', '1',
    '-subj', `/CN=${SERVER_HOST}`,
    '-addext', `subjectAltName=DNS:${SERVER_HOST}`
  ]);

  const connections: string[] = [];
  const tlsServer = createServer({
    key: readFileSync(privateKeyPath),
    cert: readFileSync(certificatePath)
  });
  const webSocketServer = new WebSocketServer({noServer: true});
  tlsServer.on('upgrade', (request, socket, head) => {
    if(request.url !== '/apiws') {
      socket.destroy();
      return;
    }
    connections.push(request.headers.origin || '');
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(serverWebSocketUrl, {
        headers: {origin: request.headers.origin || ''}
      });
      const pending: Array<{data: Buffer | ArrayBuffer | Buffer[], binary: boolean}> = [];
      client.on('message', (data, binary) => {
        if(upstream.readyState === WebSocket.OPEN) upstream.send(data, {binary});
        else pending.push({data, binary});
      });
      upstream.on('open', () => {
        for(const message of pending) upstream.send(message.data, {binary: message.binary});
        pending.length = 0;
      });
      upstream.on('message', (data, binary) => {
        if(client.readyState === WebSocket.OPEN) client.send(data, {binary});
      });
      client.on('close', () => upstream.close());
      upstream.on('close', () => client.close());
      client.on('error', () => upstream.close());
      upstream.on('error', () => client.close(1011, 'local Teagram server unavailable'));
    });
  });

  await new Promise<void>((resolve, reject) => {
    tlsServer.once('error', reject);
    tlsServer.listen(18443, '127.0.0.1', resolve);
  });

  try {
    await page.context().route('**/*', async(route) => {
      const url = new URL(route.request().url());
      if(url.origin === appOriginString) {
        url.protocol = 'http:';
        url.hostname = 'localhost';
        url.port = localAppPort;
        const response = await route.fetch({url: url.toString()});
        if(url.pathname === '/') {
          const headers = await response.headers();
          headers['content-security-policy'] = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:";
          await route.fulfill({response, headers});
        } else {
          await route.fulfill({response});
        }
      } else if(url.hostname === SERVER_HOST && url.pathname === '/.well-known/telegramd/client') {
        const response = await route.fetch({url: `${serverHttpUrl}/.well-known/telegramd/client`});
        if(response.ok()) {
          const discovery = await response.json() as {websocket?: {endpoint?: string}};
          if(discovery.websocket?.endpoint !== SERVER_WSS_ENDPOINT) {
            throw new Error('local server discovery endpoint does not match its test listener');
          }
          await route.fulfill({response});
          return;
        } else if(response.status() === 404) {
          const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8')) as {
            websocket?: {endpoint?: string},
            [key: string]: unknown
          };
          if(discovery.websocket?.endpoint && discovery.websocket.endpoint !== SERVER_WSS_ENDPOINT) {
            throw new Error('local server identity endpoint does not match its test listener');
          }
          discovery.websocket = {endpoint: SERVER_WSS_ENDPOINT};
          await route.fulfill({
            status: 200,
            headers: {'access-control-allow-origin': '*'},
            contentType: 'application/json',
            body: JSON.stringify(discovery)
          });
          return;
        } else {
          throw new Error(`local server discovery returned ${response.status()}`);
        }
      } else {
        await route.abort();
      }
    });

    await page.goto(`${appOriginString}/?noServiceWorker=1`, {waitUntil: 'domcontentloaded'});
    expect(await page.evaluate(() => isSecureContext && !!crypto.subtle)).toBe(true);

    const picker = page.getByRole('dialog');
    const hostInput = picker.getByRole('textbox', {name: 'Server host'});
    await expect(hostInput).toHaveValue('demo.teagram.io');
    await hostInput.fill(SERVER_HOST);
    await picker.getByRole('button', {name: 'Continue'}).click();

    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText(`Server: ${SERVER_HOST}`)).toBeVisible();
    await expect(confirm.getByText(/SPKI SHA-256:/)).toBeVisible();
    await confirm.getByRole('button', {name: 'Confirm and use this server'}).click();

    const returningPicker = page.getByRole('dialog');
    await expect(returningPicker.getByRole('textbox', {name: 'Server host'})).toHaveValue(SERVER_HOST);
    await returningPicker.getByRole('button', {name: 'Continue'}).click();
    await expect.poll(() => page.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_HOST__ || ''), {timeout: 20_000})
      .toBe(SERVER_HOST);

    const auth = page.locator('#auth-pages');
    await expect(auth.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
    await expect(auth.getByText(`Server: ${SERVER_HOST}`, {exact: true})).toBeVisible();
    await auth.getByRole('textbox', {name: 'Username'}).fill(SERVER_USER);
    await auth.getByRole('button', {name: 'Next'}).click();

    const password = auth.locator('input[type="password"]');
    await expect(password).toBeVisible({timeout: 30_000});
    await password.fill(SERVER_PASSWORD);
    await auth.getByRole('button', {name: 'Next'}).click();
    await expect(page.locator('#page-chats')).toBeVisible({timeout: 60_000});
    expect(connections.length).toBeGreaterThan(0);
    expect(connections.every((origin) => origin === 'https://web.teagram.io')).toBe(true);
  } finally {
    await page.close();
    for(const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    rmSync(temporaryDirectory, {recursive: true, force: true});
  }
});
