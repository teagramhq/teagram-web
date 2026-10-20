import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createServer} from 'node:https';
import {expect, test, type Page} from '@playwright/test';
import {WebSocket, WebSocketServer} from 'ws';
import {createPhaseTracker, type PhaseDiagnostic} from './customServerPhaseTracker';

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

  let appOriginString = '';
  let localAppPort = '';
  let temporaryDirectory: string | undefined;
  const streamingDocId = '987654321';
  const connections: string[] = [];
  const discoveryErrors: string[] = [];
  const customPageNavigations: string[] = [];
  let customPage: Page | undefined;
  let sharePage: Page | undefined;
  let customServerId = '';
  let tlsServer: ReturnType<typeof createServer> | undefined;
  let webSocketServer: WebSocketServer | undefined;
  const phaseDiagnostics: PhaseDiagnostic[] = [];
  const phaseTracker = createPhaseTracker((diagnostic) => {
    phaseDiagnostics.push(diagnostic);
    const description = JSON.stringify(diagnostic);
    console.info(`[custom-server-phase] ${description}`);
    testInfo.annotations.push({type: 'custom-server-phase', description});
  });
  const phaseHeartbeat = setInterval(() => phaseTracker.reportActive(), 5000);
  phaseHeartbeat.unref();
  const runPhase = <T>(name: string, operation: () => Promise<T> | T) => {
    return phaseTracker.run(name, () => test.step(name, operation));
  };
  const cleanupErrors: unknown[] = [];
  let testError: unknown;
  const runCleanup = async(name: string, operation: () => Promise<void> | void) => {
    try {
      await runPhase(name, operation);
    } catch(error) {
      cleanupErrors.push(error);
    }
  };

  try {
    await runPhase('setup', async() => {
      const appBaseUrl = new URL(testInfo.project.use.baseURL as string);
      const appOrigin = new URL(appBaseUrl);
      appOrigin.protocol = 'https:';
      appOrigin.hostname = APP_HOST;
      appOrigin.port = '';
      localAppPort = appBaseUrl.port;
      appOriginString = appOrigin.origin;
      temporaryDirectory = mkdtempSync(join(tmpdir(), 'teagram-custom-server-ws-'));
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
      webSocketServer = new WebSocketServer({noServer: true});
      tlsServer = createServer({
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
              headers['content-security-policy'] = 'script-src \'self\' \'wasm-unsafe-eval\'; worker-src \'self\' blob:';
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
      tlsServer.on('upgrade', (request, socket, head) => {
        if(request.url !== '/apiws') {
          socket.destroy();
          return;
        }
        connections.push(request.headers.origin || '');
        webSocketServer!.handleUpgrade(request, socket, head, (client) => {
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
        tlsServer!.once('error', reject);
        tlsServer!.listen(18443, '127.0.0.1', resolve);
      });

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
    });

    await runPhase('streaming: default tab', async() => {
      await expect.poll(() => page.evaluate(async(doc) => {
        const saved = await (window as any).rootScope.managers.appDocsManager.saveDoc(doc);
        return saved.supportsStreaming;
      }, streamingDocument(streamingDocId))).toBe(true);
    });

    await runPhase('worker takeover', async() => {
      customPage = await page.context().newPage();
      const customPageMainFrame = customPage.mainFrame();
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
      await expect.poll(() => customPage!.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_HOST__ || ''), {timeout: 20_000})
        .toBe(SERVER_HOST);
      customServerId = await customPage.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_ID__ as string);
      await expect.poll(() => page.evaluate(() => {
        const scriptUrl = navigator.serviceWorker.controller?.scriptURL;
        return scriptUrl ? new URL(scriptUrl).searchParams.get('__tg_server') : null;
      }), {timeout: 30_000}).toBe(customServerId);
      expect(await page.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_ID__)).toBe('default');
    });

    await runPhase('identity handshake', async() => {
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
    });

    await runPhase('streaming isolation', async() => {
      await expect.poll(() => page.evaluate(async(doc) => {
        const saved = await (window as any).rootScope.managers.appDocsManager.saveDoc(doc);
        return saved.supportsStreaming;
      }, streamingDocument(streamingDocId))).toBe(false);

      const streamProbe = await page.evaluate(async() => {
        const response = await fetch('/stream/__server-isolation-probe');
        return {status: response.status, body: await response.text()};
      });
      expect(streamProbe).toEqual({status: 200, body: 'network-default'});
    });

    await runPhase('iframe download', async() => {
      const iframeDownload = await customPage!.evaluate(async({doc}) => {
        const appDownloadManager = (window as any).appDownloadManager;
        const previousManagers = appDownloadManager.managers;
        const serviceMessagePort = (window as any).apiManagerProxy.serviceMessagePort;
        let iframeResult: Promise<{serverId: string | null, text: string}>;

        // downloadToDisc calls this only after the service worker reported the iframe
        // request. Do not listen for downloadRequestReceived here: a port invoke reaches
        // only the first listener, which would starve downloadToDisc and force the fallback.
        appDownloadManager.managers = {
          apiFileManager: {
            downloadMedia: async(options: {downloadId?: string}) => {
              if(!options.downloadId) throw new Error('download fell back without the service worker');
              const iframe = Array.from(document.querySelectorAll('iframe')).find((candidate) => {
                return new URL(candidate.src).pathname === `/d/${options.downloadId}`;
              });
              if(!iframe) throw new Error('download iframe is missing');
              iframeResult = new Promise((resolve, reject) => {
                const timeout = window.setTimeout(() => reject(new Error('service worker did not finish the iframe download')), 10_000);
                iframe.addEventListener('load', () => {
                  clearTimeout(timeout);
                  resolve({
                    serverId: new URL(iframe.src).searchParams.get('__tg_server'),
                    text: iframe.contentDocument?.body.textContent?.trim() || ''
                  });
                }, {once: true});
              });

              // Cover a slow cross-worker handoff that outlasts the service worker's old 1.5s wait.
              await new Promise<void>((resolve) => window.setTimeout(resolve, 1750));
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
          return await iframeResult;
        } finally {
          appDownloadManager.managers = previousManagers;
        }
      }, {doc: streamingDocument('987654322')});
      expect(iframeDownload).toEqual({serverId: customServerId, text: 'iframe-download-ok'});
    });

    await runPhase('sharing', async() => {
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
      // web.teagram.io always opens on the server prompt, with the remembered server preselected.
      const sharePicker = sharePage.getByRole('dialog');
      await expect(sharePicker.getByRole('textbox', {name: 'Server host'})).toHaveValue(SERVER_HOST, {timeout: 30_000});
      await sharePicker.getByRole('button', {name: 'Continue'}).click();
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
    });

    await runPhase('username/password sign-in', async() => {
      const auth = customPage!.locator('#auth-pages');
      await expect(auth.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
      expect(customPageNavigations.some((url) => new URL(url).searchParams.has('swfix'))).toBe(false);
      await expect(auth.getByText(`Server: ${SERVER_HOST}`, {exact: true})).toBeVisible();
      await auth.getByRole('textbox', {name: 'Username'}).fill(SERVER_USER);
      await auth.getByRole('button', {name: 'Next'}).click();

      const password = auth.locator('input[name="notsearch_password"]');
      await expect(password).toBeVisible({timeout: 30_000});
      await password.fill(SERVER_PASSWORD);
      await auth.getByRole('button', {name: 'Next'}).click();
      await expect(customPage!.locator('#page-chats')).toBeVisible({timeout: 60_000});
      expect(connections.length).toBeGreaterThan(0);
      expect(connections.every((origin) => origin === 'https://web.teagram.io')).toBe(true);
    });
  } catch(error) {
    testError = error;
    throw error;
  } finally {
    await runCleanup('cleanup: close share tab', async() => {
      if(sharePage) await sharePage.close();
    });
    await runCleanup('cleanup: close custom tab', async() => {
      if(customPage) await customPage.close();
    });
    await runCleanup('cleanup: close default tab', async() => {
      await page.close();
    });
    await runCleanup('cleanup: terminate WebSocket clients', () => {
      if(!webSocketServer) return;
      for(const client of webSocketServer.clients) client.terminate();
    });
    await runCleanup('cleanup: close WebSocket server', async() => {
      if(!webSocketServer) return;
      await new Promise<void>((resolve, reject) => {
        webSocketServer!.close((error) => error ? reject(error) : resolve());
      });
    });
    await runCleanup('cleanup: close TLS server', async() => {
      const server = tlsServer;
      if(!server?.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    });
    await runCleanup('cleanup: remove temporary directory', () => {
      if(temporaryDirectory) rmSync(temporaryDirectory, {recursive: true, force: true});
    });
    clearInterval(phaseHeartbeat);
    if(cleanupErrors.length) {
      throw Object.assign(new Error('custom-server test cleanup failed'), {
        cause: testError,
        errors: cleanupErrors
      });
    }
  }

  const completedPhases = phaseDiagnostics
    .filter((diagnostic) => diagnostic.status === 'completed')
    .map((diagnostic) => diagnostic.phase);
  expect(completedPhases).toEqual([
    'setup',
    'streaming: default tab',
    'worker takeover',
    'identity handshake',
    'streaming isolation',
    'iframe download',
    'sharing',
    'username/password sign-in',
    'cleanup: close share tab',
    'cleanup: close custom tab',
    'cleanup: close default tab',
    'cleanup: terminate WebSocket clients',
    'cleanup: close WebSocket server',
    'cleanup: close TLS server',
    'cleanup: remove temporary directory'
  ]);
  expect(phaseDiagnostics.every(({elapsedMs}) => Number.isFinite(elapsedMs) && elapsedMs >= 0)).toBe(true);
  expect(phaseDiagnostics.every((diagnostic) => Object.keys(diagnostic).sort().join(',') === 'elapsedMs,lastCompletedPhase,phase,status')).toBe(true);
  expect(testInfo.annotations
    .filter((annotation) => annotation.type === 'custom-server-phase')
    .map((annotation) => annotation.description))
    .toEqual(phaseDiagnostics.map((diagnostic) => JSON.stringify(diagnostic)));
});
