import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createServer} from 'node:https';
import {expect, test, type Page} from '@playwright/test';
import {WebSocket, WebSocketServer} from 'ws';

const SERVER_HOST = 'second-server.example.test';
const APP_HOST = 'web.teagram.io';
const SERVER_WSS_ENDPOINT = `wss://${SERVER_HOST}/apiws`;
const SERVER_USER = process.env.TEAGRAM_CUSTOM_SERVER_TEST_USER || 'custom_server_user';
const SERVER_PASSWORD = process.env.TEAGRAM_CUSTOM_SERVER_TEST_PASSWORD || 'Teagram-Test-Password-123!';

function streamingDocument(id: string) {
  return {
    _: 'document',
    id,
    access_hash: '1',
    file_reference: [] as number[],
    date: 1,
    mime_type: 'video/mp4',
    size: 1,
    dc_id: 2,
    pFlags: {},
    attributes: [{
      _: 'documentAttributeVideo',
      duration: 1,
      w: 1,
      h: 1,
      pFlags: {}
    }]
  };
}

test('isolates two server tabs when a custom server worker takes control', async({page}, testInfo) => {
  const serverHttpUrl = process.env.TEAGRAM_CUSTOM_SERVER_TEST_HTTP_URL;
  const serverWebSocketUrl = process.env.TEAGRAM_CUSTOM_SERVER_TEST_WS_URL;
  const hasServerFixture = !!serverHttpUrl && !!serverWebSocketUrl;
  test.skip(!process.env.CI && !hasServerFixture, 'CI must provide the local Teagram server');
  if(!hasServerFixture) throw new Error('CI must provide the local Teagram server');

  const appBaseUrl = new URL(testInfo.project.use.baseURL as string);
  const appOrigin = new URL(appBaseUrl);
  appOrigin.protocol = 'https:';
  appOrigin.hostname = APP_HOST;
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
    '-addext', `subjectAltName=DNS:${SERVER_HOST},DNS:${APP_HOST}`
  ]);

  // Both hosts resolve to this listener (see playwright.private-auth.config.ts) because
  // Playwright routing does not cover module imports inside the MTProto SharedWorker.
  const connections: string[] = [];
  let customPage: Page | undefined;
  let sharePage: Page | undefined;
  const tlsServer = createServer({
    key: readFileSync(privateKeyPath),
    cert: readFileSync(certificatePath)
  }, (request, response) => {
    const host = (request.headers.host || '').replace(/:\d+$/, '');
    const url = new URL(request.url || '/', `https://${host}`);
    if(host === APP_HOST) {
      if(url.pathname === '/stream/__server-isolation-probe') {
        response.writeHead(200, {'content-type': 'text/plain'});
        response.end('network-default');
        return;
      }

      const upstream = httpRequest({
        host: 'localhost',
        port: localAppPort,
        method: request.method,
        path: request.url,
        headers: {...request.headers, host: `localhost:${localAppPort}`}
      }, (upstreamResponse) => {
        const headers = {...upstreamResponse.headers};
        if(url.pathname === '/') {
          headers['content-security-policy'] = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:";
        }
        response.writeHead(upstreamResponse.statusCode || 502, headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => response.destroy());
      request.pipe(upstream);
    } else if(host === SERVER_HOST && url.pathname === '/.well-known/telegramd/client') {
      void fetch(`${serverHttpUrl}/.well-known/telegramd/client`).then(async(upstreamResponse) => {
        const body = await upstreamResponse.text();
        if(!upstreamResponse.ok) throw new Error(`local server discovery returned ${upstreamResponse.status}`);
        const discovery = JSON.parse(body) as {websocket?: {endpoint?: string}};
        if(discovery.websocket?.endpoint !== SERVER_WSS_ENDPOINT) {
          throw new Error(`local server discovery advertises ${discovery.websocket?.endpoint}, expected ${SERVER_WSS_ENDPOINT}`);
        }
        response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers));
        response.end(body);
      }).catch((error: Error) => {
        discoveryErrors.push(error.message);
        response.writeHead(502);
        response.end();
      });
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const discoveryErrors: string[] = [];
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
    await page.context().route('**/*', (route) => {
      const {hostname} = new URL(route.request().url());
      return hostname === APP_HOST || hostname === SERVER_HOST ? route.continue() : route.abort();
    });

    await page.goto(appOriginString, {waitUntil: 'domcontentloaded'});
    expect(await page.evaluate(() => isSecureContext && !!crypto.subtle)).toBe(true);

    const defaultPicker = page.getByRole('dialog');
    await defaultPicker.getByRole('textbox', {name: 'Server host'}).fill(APP_HOST);
    await defaultPicker.getByRole('button', {name: 'Continue'}).click();
    await expect(page.locator('#auth-pages')).toBeVisible({timeout: 30_000});
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    const streamingDocId = '987654321';
    await expect.poll(() => page.evaluate(async(doc) => {
      const saved = await (window as any).rootScope.managers.appDocsManager.saveDoc(doc);
      return saved.supportsStreaming;
    }, streamingDocument(streamingDocId))).toBe(true);

    customPage = await page.context().newPage();
    const customPageMainFrame = customPage.mainFrame();
    const customPageNavigations: string[] = [];
    customPage.on('framenavigated', (frame) => {
      if(frame === customPageMainFrame) customPageNavigations.push(frame.url());
    });
    await customPage.goto(appOriginString, {waitUntil: 'domcontentloaded'});
    expect(await customPage.evaluate(() => isSecureContext && !!crypto.subtle)).toBe(true);

    const picker = customPage.getByRole('dialog');
    const hostInput = picker.getByRole('textbox', {name: 'Server host'});
    await hostInput.fill(SERVER_HOST);
    await picker.getByRole('button', {name: 'Continue'}).click();

    const confirm = customPage.getByRole('dialog');
    await expect(confirm.getByText(`Server: ${SERVER_HOST}`)).toBeVisible();
    expect(discoveryErrors).toEqual([]);
    await expect(confirm.getByText(/SPKI SHA-256:/)).toBeVisible();
    await confirm.getByRole('button', {name: 'Confirm and use this server'}).click();

    const returningPicker = customPage.getByRole('dialog');
    await expect(returningPicker.getByRole('textbox', {name: 'Server host'})).toHaveValue(SERVER_HOST);
    await returningPicker.getByRole('button', {name: 'Continue'}).click();
    await expect.poll(() => customPage.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_HOST__ || ''), {timeout: 20_000})
      .toBe(SERVER_HOST);

    const customServerId = await customPage.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_ID__ as string);
    await expect.poll(() => page.evaluate(() => {
      const scriptUrl = navigator.serviceWorker.controller?.scriptURL;
      return scriptUrl ? new URL(scriptUrl).searchParams.get('__tg_server') : null;
    }), {timeout: 30_000}).toBe(customServerId);
    expect(await page.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_ID__)).toBe('default');

    const handshake = await page.evaluate((serverId) => new Promise((resolve, reject) => {
      const controller = navigator.serviceWorker.controller;
      if(!controller) return reject(new Error('custom server worker did not take control'));

      const channel = new MessageChannel();
      const timer = setTimeout(() => reject(new Error('service worker identity check timed out')), 5000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      controller.postMessage({type: 'teagram:server-handshake', serverId}, [channel.port2]);
    }), 'default');
    expect(handshake).toEqual({serverId: customServerId, accepted: false});

    await expect.poll(() => page.evaluate(async(doc) => {
      const saved = await (window as any).rootScope.managers.appDocsManager.saveDoc(doc);
      return saved.supportsStreaming;
    }, streamingDocument(streamingDocId))).toBe(false);

    const streamProbe = await page.evaluate(async() => {
      const response = await fetch('/stream/__server-isolation-probe');
      return {status: response.status, body: await response.text()};
    });
    expect(streamProbe).toEqual({status: 200, body: 'network-default'});

    const iframeDownload = await customPage.evaluate(async({serverId, doc}) => {
      const appDownloadManager = (window as any).appDownloadManager;
      const previousManagers = appDownloadManager.managers;
      const serviceMessagePort = (window as any).apiManagerProxy.serviceMessagePort;
      let onRequestReceived = (_id: string) => {};
      const downloadResult = new Promise<{serverId: string | null, text: string}>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          serviceMessagePort.removeEventListener('downloadRequestReceived', onRequestReceived);
          reject(new Error('service worker did not finish the iframe download'));
        }, 10_000);
        onRequestReceived = (id: string) => {
          const iframe = Array.from(document.querySelectorAll('iframe')).find((candidate) => {
            return new URL(candidate.src).pathname === `/d/${id}`;
          });
          if(!iframe) return;

          iframe.addEventListener('load', () => {
            clearTimeout(timeout);
            serviceMessagePort.removeEventListener('downloadRequestReceived', onRequestReceived);
            resolve({
              serverId: new URL(iframe.src).searchParams.get('__tg_server'),
              text: iframe.contentDocument?.body.textContent?.trim() || ''
            });
          }, {once: true});
        };
        serviceMessagePort.addEventListener('downloadRequestReceived', onRequestReceived);
      });

      appDownloadManager.managers = {
        apiFileManager: {
          downloadMedia: async(options: {downloadId: string}) => {
            const download = await serviceMessagePort.invoke('download', {
              id: options.downloadId,
              headers: {'content-type': 'text/plain'}
            }, true);
            await serviceMessagePort.invoke('downloadChunk', {
              id: options.downloadId,
              chunk: new TextEncoder().encode('iframe-download-ok')
            });
            await serviceMessagePort.invoke('downloadFinalize', options.downloadId);
            await download.result;
            return new Blob(['download-complete'], {type: 'text/plain'});
          }
        }
      };

      try {
        await appDownloadManager.downloadToDisc({media: doc, fileName: 'custom-server-iframe-download.txt'});
        return await downloadResult;
      } finally {
        appDownloadManager.managers = previousManagers;
        serviceMessagePort.removeEventListener('downloadRequestReceived', onRequestReceived);
      }
    }, {serverId: customServerId, doc: streamingDocument('987654322')});
    expect(iframeDownload).toEqual({serverId: customServerId, text: 'iframe-download-ok'});

    sharePage = await page.context().newPage();
    await sharePage.setContent('<form method="post" enctype="multipart/form-data"><input name="title"><input name="text"><input name="url"></form>');
    await sharePage.evaluate((action) => {
      const form = document.querySelector('form')!;
      (form.elements.namedItem('title') as HTMLInputElement).value = 'Share target title';
      (form.elements.namedItem('text') as HTMLInputElement).value = 'Share target text';
      (form.elements.namedItem('url') as HTMLInputElement).value = 'https://example.test/shared';
      form.action = action;
      form.submit();
    }, `${appOriginString}/share/`);
    await expect(sharePage.locator('#auth-pages')).toBeVisible({timeout: 30_000});
    await expect.poll(() => sharePage!.evaluate(() => {
      const share = (window as any).apiManagerProxy.share;
      return share && {title: share.title, text: share.text, url: share.url};
    }), {timeout: 10_000}).toEqual({
      title: 'Share target title',
      text: 'Share target text',
      url: 'https://example.test/shared'
    });
    expect(await page.evaluate(() => (window as any).apiManagerProxy.share)).toBeUndefined();

    const auth = customPage.locator('#auth-pages');
    await expect(auth.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
    expect(customPageNavigations.some((url) => new URL(url).searchParams.has('swfix'))).toBe(false);
    await expect(auth.getByText(`Server: ${SERVER_HOST}`, {exact: true})).toBeVisible();
    await auth.getByRole('textbox', {name: 'Username'}).fill(SERVER_USER);
    await auth.getByRole('button', {name: 'Next'}).click();

    const password = auth.locator('input[name="notsearch_password"]');
    await expect(password).toBeVisible({timeout: 30_000});
    await password.fill(SERVER_PASSWORD);
    await auth.getByRole('button', {name: 'Next'}).click();
    await expect(customPage.locator('#page-chats')).toBeVisible({timeout: 60_000});
    expect(connections.length).toBeGreaterThan(0);
    expect(connections.every((origin) => origin === 'https://web.teagram.io')).toBe(true);
  } finally {
    await sharePage?.close();
    await customPage?.close();
    await page.close();
    for(const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    rmSync(temporaryDirectory, {recursive: true, force: true});
  }
});
