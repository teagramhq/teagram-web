import {execFileSync} from 'node:child_process';
import {createPublicKey} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {request as httpRequest, type IncomingMessage, type ServerResponse} from 'node:http';
import type {Duplex} from 'node:stream';
import {createServer, request as httpsRequest} from 'node:https';
import {expect, test, type Page, type TestInfo} from '@playwright/test';
import {WebSocket, WebSocketServer} from 'ws';
import {createPhaseTracker, type PhaseDiagnostic} from './customServerPhaseTracker';

const SERVER_HOST = 'second-server.example.test';
const APP_HOST = 'web.teagram.io';
const SERVER_WSS_ENDPOINT = `wss://${SERVER_HOST}/apiws`;
const SERVER_USER = process.env.TEAGRAM_CUSTOM_SERVER_TEST_USER || 'custom_server_user';
const SERVER_PASSWORD = process.env.TEAGRAM_CUSTOM_SERVER_TEST_PASSWORD || 'Teagram-Test-Password-123!';

function deleteUnboundCustomServerAuthKeys() {
  const databaseUrl = process.env.TG_POSTGRES_DSN;
  if(process.env.CI !== 'true' || !databaseUrl) {
    throw new Error('auth-key deletion requires the disposable CI Postgres fixture');
  }

  const target = new URL(databaseUrl);
  if(!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || target.pathname !== '/teagram') {
    throw new Error('auth-key deletion requires the local teagram CI database');
  }

  const sql = `
    WITH deleted AS (
      DELETE FROM public.auth_keys
      WHERE user_id IS NULL
        AND pending_user_id = (
          SELECT id FROM public.users WHERE username = lower(:'server_user')
        )
      RETURNING 1
    )
    SELECT count(*) FROM deleted;
  `;
  const deletedCount = execFileSync('psql', [
    '-X',
    '-q',
    '-t',
    '-A',
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    `server_user=${SERVER_USER}`,
    databaseUrl
  ], {encoding: 'utf8', input: sql}).trim();
  const count = Number(deletedCount);
  if(!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`expected to delete an unbound auth key, got ${deletedCount || 'no count'}`);
  }
  return count;
}

function trackTlsServerSockets(server: ReturnType<typeof createServer>) {
  const sockets = new Map<Duplex, 'https' | 'websocket'>();
  const track = (socket: Duplex, kind: 'https' | 'websocket') => {
    sockets.set(socket, kind);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('connection', (socket) => {
    track(socket, 'https');
  });
  return {
    markUpgrade(socket: Duplex) {
      track(socket, 'websocket');
    },
    async closeAll() {
      const closing = [...sockets.keys()].map((socket) => new Promise<void>((resolve) => {
        socket.once('close', resolve);
        socket.destroy();
      }));
      await Promise.all(closing);
    },
    snapshot() {
      return {
        https: [...sockets.values()].filter((kind) => kind === 'https').length,
        websocket: [...sockets.values()].filter((kind) => kind === 'websocket').length
      };
    }
  };
}

async function closeTlsServer(
  server: ReturnType<typeof createServer>,
  socketTracker?: ReturnType<typeof trackTlsServerSockets>,
  reportListenerClose?: (stage: 'pending' | 'completed') => void
) {
  let listenerClose: Promise<void> | undefined;
  if(server.listening) {
    listenerClose = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        reportListenerClose?.('completed');
        if(error) reject(error);
        else resolve();
      });
    });
    reportListenerClose?.('pending');
  }
  server.closeAllConnections();
  const shutdownResults = await Promise.allSettled([
    listenerClose || Promise.resolve(),
    socketTracker?.closeAll() || Promise.resolve()
  ]);
  const shutdownError = shutdownResults.find((result) => result.status === 'rejected');
  if(shutdownError?.status === 'rejected') throw shutdownError.reason;
}

async function cleanupTlsTestFixture(
  destroyClient: () => void,
  closeTask: Promise<void>,
  temporaryDirectory: string
) {
  try {
    destroyClient();
    await closeTask;
  } finally {
    rmSync(temporaryDirectory, {recursive: true, force: true});
  }
}

async function withTlsTestDirectory<T>(prefix: string, action: (directory: string) => Promise<T>) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await action(temporaryDirectory);
  } finally {
    rmSync(temporaryDirectory, {recursive: true, force: true});
  }
}

function throwTlsTestErrors(testError: unknown, cleanupError: unknown) {
  if(testError !== undefined && cleanupError !== undefined) {
    throw Object.assign(new Error('TLS fixture test and cleanup failed'), {
      cause: testError,
      errors: [testError, cleanupError]
    });
  }
  if(testError !== undefined) throw testError;
  if(cleanupError !== undefined) throw cleanupError;
}

function holdTlsResponseOpen(response: ServerResponse) {
  response.writeHead(200, {'content-type': 'text/plain'});
  response.flushHeaders();
}

function getTlsConnectionCount(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve, reject) => {
    server.getConnections((error, count) => error ? reject(error) : resolve(count));
  });
}

function hasOnlyConnectionResetErrors(errors: Error[]) {
  return errors.every((error) => (error as Error & {code?: string}).code === 'ECONNRESET');
}

function createTlsFixtureCredentials(directory: string, hostnames: string[]) {
  const privateKeyPath = join(directory, 'server-key.pem');
  const certificatePath = join(directory, 'server-cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', privateKeyPath,
    '-out', certificatePath,
    '-days', '1',
    '-subj', `/CN=${hostnames[0]}`,
    '-addext', `subjectAltName=${hostnames.map((hostname) => `DNS:${hostname}`).join(',')}`
  ]);
  return {privateKeyPath, certificatePath};
}

async function withPrivateArtifactWebSocketFixture<T>(
  endpoint: URL,
  action: (fixture: {unrelatedRequests: string[], unrelatedUrl: string}) => Promise<T>
) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'teagram-private-artifact-websocket-'));
  const credentials = createTlsFixtureCredentials(temporaryDirectory, [endpoint.hostname]);
  const server = createServer({
    key: readFileSync(credentials.privateKeyPath),
    cert: readFileSync(credentials.certificatePath)
  });
  const socketTracker = trackTlsServerSockets(server);
  const webSocketServer = new WebSocketServer({noServer: true});
  const unrelatedRequests: string[] = [];
  server.on('upgrade', (request, socket, head) => {
    socketTracker.markUpgrade(socket);
    const pathname = new URL(request.url || '/', `https://${endpoint.host}`).pathname;
    if(pathname === '/unrelated') unrelatedRequests.push(request.url || '');
    if(pathname !== endpoint.pathname && pathname !== '/unrelated') {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      client.on('error', () => {});
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(endpoint.port), '127.0.0.1', resolve);
    });
    return await action({unrelatedRequests, unrelatedUrl: `${endpoint.origin}/unrelated`});
  } finally {
    try {
      for(const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((error) => error ? reject(error) : resolve());
      });
    } finally {
      try {
        if(server.listening) await closeTlsServer(server, socketTracker);
      } finally {
        rmSync(temporaryDirectory, {recursive: true, force: true});
      }
    }
  }
}

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

test('closes a TLS listener with an active HTTPS response', async() => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'teagram-custom-server-cleanup-'));
  let privateKeyPath: string | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let socketTracker: ReturnType<typeof trackTlsServerSockets> | undefined;
  let response: IncomingMessage | undefined;
  let responseClosed = false;
  let closeTask: Promise<void> | undefined;
  let testError: unknown;
  const responseErrors: Error[] = [];

  try {
    const credentials = createTlsFixtureCredentials(temporaryDirectory, ['localhost']);
    privateKeyPath = credentials.privateKeyPath;
    server = createServer({
      key: readFileSync(credentials.privateKeyPath),
      cert: readFileSync(credentials.certificatePath)
    }, (_request, serverResponse) => {
      holdTlsResponseOpen(serverResponse);
    });
    socketTracker = trackTlsServerSockets(server);

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if(!address || typeof address === 'string') throw new Error('TLS fixture did not bind to a TCP port');

    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpsRequest({
        host: '127.0.0.1',
        port: address.port,
        path: '/',
        servername: 'localhost',
        rejectUnauthorized: false
      }, resolve);
      request.once('error', reject);
      request.end();
    });
    response.on('error', (error) => responseErrors.push(error));
    const responseClosePromise = new Promise<void>((resolve) => {
      response!.once('close', () => {
        responseClosed = true;
        resolve();
      });
    });
    response.resume();

    closeTask = closeTlsServer(server, socketTracker);
    const closeCompleted = await Promise.race([
      closeTask.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))
    ]);
    expect(closeCompleted).toBe(true);
    const responseWasClosed = await Promise.race([
      responseClosePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))
    ]);
    expect(responseWasClosed).toBe(true);
    const remainingConnections = await getTlsConnectionCount(server);
    expect(remainingConnections).toBe(0);
  } catch(error) {
    testError = error;
  }

  let cleanupError: unknown;
  try {
    await cleanupTlsTestFixture(
      () => response?.destroy(),
      closeTask || (server ? closeTlsServer(server, socketTracker) : Promise.resolve()),
      temporaryDirectory
    );
  } catch(error) {
    cleanupError = error;
  }
  throwTlsTestErrors(testError, cleanupError);

  expect(responseClosed).toBe(true);
  expect(hasOnlyConnectionResetErrors(responseErrors)).toBe(true);
  if(privateKeyPath) expect(existsSync(privateKeyPath)).toBe(false);
});

test('removes a partial TLS key when fixture credential setup fails', async() => {
  let temporaryDirectory = '';
  const setupError = new Error('OpenSSL setup failed');
  const setupTask = withTlsTestDirectory('teagram-custom-server-setup-failure-', async(directory) => {
    temporaryDirectory = directory;
    writeFileSync(join(directory, 'server-key.pem'), 'partial private key');
    throw setupError;
  });

  await expect(setupTask).rejects.toBe(setupError);
  expect(temporaryDirectory).not.toBe('');
  expect(existsSync(temporaryDirectory)).toBe(false);
});

async function verifyStalledTlsShutdownCleanup(temporaryDirectory: string) {
  const credentials = createTlsFixtureCredentials(temporaryDirectory, ['localhost']);
  const shutdownError = new Error('TLS shutdown stalled');
  const assertionError = new Error('TLS listener did not close before the deadline');
  let clientDestroyed = false;
  let rejectShutdown!: (error: Error) => void;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const closeTask = new Promise<void>((_resolve, reject) => {
    rejectShutdown = reject;
    shutdownTimer = setTimeout(() => reject(shutdownError), 100);
  });

  try {
    let cleanupError: unknown;
    try {
      await cleanupTlsTestFixture(
        () => {
          clientDestroyed = true;
          if(shutdownTimer) clearTimeout(shutdownTimer);
          shutdownTimer = setTimeout(() => rejectShutdown(shutdownError), 10);
        },
        closeTask,
        temporaryDirectory
      );
    } catch(error) {
      cleanupError = error;
    }
    expect(cleanupError).toBe(shutdownError);
    expect(clientDestroyed).toBe(true);
    expect(existsSync(credentials.privateKeyPath)).toBe(false);
    let reportedError: unknown;
    try {
      throwTlsTestErrors(assertionError, cleanupError);
    } catch(error) {
      reportedError = error;
    }
    expect(reportedError).toBeInstanceOf(Error);
    expect((reportedError as Error & {errors: unknown[], cause?: unknown}).errors).toEqual([assertionError, shutdownError]);
    expect((reportedError as Error & {errors: unknown[], cause?: unknown}).cause).toBe(assertionError);
  } finally {
    if(shutdownTimer) clearTimeout(shutdownTimer);
  }
}

test('removes TLS keys when a stalled shutdown rejects after client teardown', () => withTlsTestDirectory(
  'teagram-custom-server-stalled-cleanup-',
  verifyStalledTlsShutdownCleanup
));

test('does not wait on a pending TLS upgrade after stopping the listener', async() => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'teagram-custom-server-upgrade-'));
  let server: ReturnType<typeof createServer> | undefined;
  let socketTracker: ReturnType<typeof trackTlsServerSockets> | undefined;
  let upgradeSocket: Duplex | undefined;
  let clientRequest: ReturnType<typeof httpsRequest> | undefined;
  let closeTask: Promise<void> | undefined;
  let testError: unknown;
  const requestErrors: Error[] = [];

  try {
    const credentials = createTlsFixtureCredentials(temporaryDirectory, ['localhost']);
    server = createServer({
      key: readFileSync(credentials.privateKeyPath),
      cert: readFileSync(credentials.certificatePath)
    });
    socketTracker = trackTlsServerSockets(server);
    const upgradeReceived = new Promise<void>((resolve, reject) => {
      server!.once('upgrade', (_request, socket) => {
        upgradeSocket = socket;
        socketTracker!.markUpgrade(socket);
        resolve();
      });
      server!.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if(!address || typeof address === 'string') throw new Error('TLS fixture did not bind to a TCP port');

    clientRequest = httpsRequest({
      host: '127.0.0.1',
      port: address.port,
      path: '/apiws',
      servername: 'localhost',
      rejectUnauthorized: false,
      headers: {connection: 'Upgrade', upgrade: 'websocket'}
    });
    clientRequest.on('error', (error) => requestErrors.push(error));
    clientRequest.end();
    await upgradeReceived;

    closeTask = closeTlsServer(server, socketTracker);
    const closeCompleted = await Promise.race([
      closeTask.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))
    ]);
    expect(closeCompleted).toBe(true);
  } catch(error) {
    testError = error;
  }

  let cleanupError: unknown;
  try {
    await cleanupTlsTestFixture(
      () => {
        clientRequest?.destroy();
        upgradeSocket?.destroy();
      },
      closeTask || (server ? closeTlsServer(server, socketTracker) : Promise.resolve()),
      temporaryDirectory
    );
  } catch(error) {
    cleanupError = error;
  }
  throwTlsTestErrors(testError, cleanupError);

  expect(hasOnlyConnectionResetErrors(requestErrors)).toBe(true);
  expect(socketTracker?.snapshot()).toEqual({https: 0, websocket: 0});
});

test('private artifact discovers a server from web.teagram.io without CSP violations', async({page}, testInfo) => {
  test.skip(testInfo.project.name !== 'private-artifact-chromium', 'requires the production artifact preview');
  const manifest = JSON.parse(readFileSync(resolve('dist/mtproto-target.json'), 'utf8')) as {mode: string, endpoint: string};
  if(manifest.mode !== 'private') throw new Error('private artifact browser test requires a private build');
  const privateEndpoint = new URL(manifest.endpoint);
  const serverHost = privateEndpoint.hostname;
  if(serverHost === APP_HOST) throw new Error('private artifact endpoint must differ from the picker host');

  const appBaseUrl = new URL(testInfo.project.use.baseURL as string);
  const appPort = Number(appBaseUrl.port);
  const appOrigin = `https://${APP_HOST}`;
  const edgeConfig = readFileSync(resolve('deploy/teagram-web/nginx.conf'), 'utf8');
  const edgeCsp = edgeConfig.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
  if(!edgeCsp) throw new Error('deployment CSP is missing from deploy/teagram-web/nginx.conf');

  const rsaPublicKey = createPublicKey(readFileSync(resolve('scripts/fixtures/private-mtproto-public.pem')));
  const discovery = {
    version: 1,
    mtproto: {
      endpoint: `${serverHost}:2443`,
      dc_id: 2,
      rsa_spki: rsaPublicKey.export({format: 'der', type: 'spki'}).toString('base64')
    },
    websocket: {endpoint: privateEndpoint.href}
  };
  const discoveryRequests: string[] = [];
  let tlsServer: ReturnType<typeof createServer> | undefined;
  let tlsSocketTracker: ReturnType<typeof trackTlsServerSockets> | undefined;
  let webSocketServer: WebSocketServer | undefined;
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'teagram-private-artifact-discovery-'));

  try {
    const credentials = createTlsFixtureCredentials(temporaryDirectory, [APP_HOST, serverHost]);
    tlsServer = createServer({
      key: readFileSync(credentials.privateKeyPath),
      cert: readFileSync(credentials.certificatePath)
    }, (request, response) => {
      const host = (request.headers.host || '').replace(/:\d+$/, '');
      const url = new URL(request.url || '/', `https://${host}`);
      if(host === serverHost && url.pathname === '/.well-known/teagramd/client') {
        discoveryRequests.push(url.pathname);
        response.writeHead(200, {
          'access-control-allow-origin': '*',
          'content-type': 'application/json'
        });
        response.end(JSON.stringify(discovery));
        return;
      }
      if(host !== APP_HOST && host !== serverHost) {
        response.writeHead(404);
        response.end();
        return;
      }

      const upstream = httpRequest({
        host: 'localhost',
        port: appPort,
        method: request.method,
        path: request.url,
        headers: {...request.headers, host: `localhost:${appPort}`}
      }, (upstreamResponse) => {
        const headers = {...upstreamResponse.headers, 'content-security-policy': edgeCsp};
        response.writeHead(upstreamResponse.statusCode || 502, headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => response.destroy());
      request.pipe(upstream);
    });
    tlsSocketTracker = trackTlsServerSockets(tlsServer);
    webSocketServer = new WebSocketServer({noServer: true});
    tlsServer.on('upgrade', (request, socket, head) => {
      tlsSocketTracker!.markUpgrade(socket);
      if(request.url !== privateEndpoint.pathname) {
        socket.destroy();
        return;
      }
      webSocketServer!.handleUpgrade(request, socket, head, (client) => {
        client.on('error', () => {});
      });
    });

    await new Promise<void>((resolveListen, reject) => {
      tlsServer!.once('error', reject);
      tlsServer!.listen(18443, '127.0.0.1', resolveListen);
    });

    const cspViolations: string[] = [];
    page.on('console', (message) => {
      if(message.type() === 'error' && /violates the following directive|Refused to .* because it violates/i.test(message.text())) {
        cspViolations.push(message.text());
      }
    });
    await page.goto(appOrigin, {waitUntil: 'domcontentloaded'});

    const picker = page.getByRole('dialog');
    await expect(picker.getByRole('heading', {name: 'Choose your server'})).toBeVisible();
    await picker.getByRole('textbox', {name: 'Server host'}).fill(serverHost);
    await picker.getByRole('button', {name: 'Continue'}).click();

    const confirmation = page.getByRole('dialog');
    await expect(confirmation.getByText(`Server: ${serverHost}`)).toBeVisible();
    expect(discoveryRequests).toEqual(['/.well-known/teagramd/client']);
    await confirmation.getByRole('button', {name: 'Confirm and use this server'}).click();

    const returningPicker = page.getByRole('dialog');
    await expect(returningPicker.getByRole('textbox', {name: 'Server host'})).toHaveValue(serverHost);
    await returningPicker.getByRole('button', {name: 'Continue'}).click();
    await expect(page.locator('#auth-pages')).toBeVisible({timeout: 30_000});
    expect(await page.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_HOST__)).toBe(serverHost);
    expect(await page.locator('meta[data-server-policy]').getAttribute('content'))
    .toBe(`connect-src 'self' https://${serverHost} ${privateEndpoint.href};`);
    expect(discoveryRequests).toEqual(['/.well-known/teagramd/client', '/.well-known/teagramd/client']);
    expect(cspViolations).toEqual([]);

    const pinnedPage = await page.context().newPage();
    const pinnedCspViolations: string[] = [];
    pinnedPage.on('console', (message) => {
      if(message.type() === 'error' && /violates the following directive|Refused to .* because it violates/i.test(message.text())) {
        pinnedCspViolations.push(message.text());
      }
    });
    await pinnedPage.goto(`https://${serverHost}`, {waitUntil: 'domcontentloaded'});
    await expect(pinnedPage.locator('#auth-pages')).toBeVisible({timeout: 30_000});
    expect(await pinnedPage.getByRole('dialog').count()).toBe(0);
    expect(await pinnedPage.locator('meta[data-server-policy]').getAttribute('content'))
    .toBe(`connect-src 'self' ${privateEndpoint.href};`);
    expect(pinnedCspViolations).toEqual([]);
    await pinnedPage.close();
  } finally {
    try {
      if(webSocketServer) {
        for(const client of webSocketServer.clients) client.terminate();
        await new Promise<void>((resolveClose, reject) => {
          webSocketServer!.close((error) => error ? reject(error) : resolveClose());
        });
      }
    } finally {
      try {
        if(tlsServer?.listening) await closeTlsServer(tlsServer, tlsSocketTracker);
      } finally {
        rmSync(temporaryDirectory, {recursive: true, force: true});
      }
    }
  }
});

async function expectUnrelatedConnectionsBlocked(page: Page, httpsRequests: string[], webSocketRequests: string[], webSocketUrl: string) {
  const httpsRequestCount = httpsRequests.length;
  const webSocketRequestCount = webSocketRequests.length;
  const pageWebSocketRequests: string[] = [];
  page.on('websocket', (socket) => {
    if(socket.url() === webSocketUrl) pageWebSocketRequests.push(socket.url());
  });
  const blockedUris = await page.evaluate(async(url: string) => {
    const blocked: string[] = [];
    const listener = (event: SecurityPolicyViolationEvent) => {
      if(event.effectiveDirective === 'connect-src') blocked.push(event.blockedURI);
    };
    document.addEventListener('securitypolicyviolation', listener);
    const fetchAttempt = fetch('https://unrelated.example.test/probe', {mode: 'no-cors'}).catch((): void => {});
    const webSocketAttempt = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      try {
        const socket = new WebSocket(url);
        socket.addEventListener('open', () => {
          socket.close();
          finish();
        }, {once: true});
        socket.addEventListener('error', finish, {once: true});
        socket.addEventListener('close', finish, {once: true});
      } catch{
        finish();
      }
    });
    await Promise.all([fetchAttempt, webSocketAttempt]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.removeEventListener('securitypolicyviolation', listener);
    return blocked;
  }, webSocketUrl);

  expect(httpsRequests.slice(httpsRequestCount)).toEqual([]);
  expect(webSocketRequests.slice(webSocketRequestCount)).toEqual([]);
  expect(pageWebSocketRequests).toEqual([]);
  expect(blockedUris.some((uri) => uri.startsWith('https://unrelated.example.test'))).toBe(true);
}

test('private artifact blocks unrelated HTTPS and WSS in picker and pinned modes', async({page}, testInfo) => {
  test.skip(testInfo.project.name !== 'private-artifact-firefox', 'requires Firefox');
  const manifest = JSON.parse(readFileSync(resolve('dist/mtproto-target.json'), 'utf8')) as {mode: string, endpoint: string};
  if(manifest.mode !== 'private') throw new Error('private artifact browser test requires a private build');
  const privateEndpoint = new URL(manifest.endpoint);
  const serverHost = privateEndpoint.hostname;
  if(serverHost === APP_HOST) throw new Error('private artifact endpoint must differ from the picker host');

  return withPrivateArtifactWebSocketFixture(new URL('wss://localhost:18443/apiws'), (fixture) =>
    runPrivateArtifactFirefoxEgress(page, testInfo, privateEndpoint, fixture)
  );
});

async function runPrivateArtifactFirefoxEgress(
  page: Page,
  testInfo: TestInfo,
  privateEndpoint: URL,
  webSocketFixture: {unrelatedRequests: string[], unrelatedUrl: string}
) {
  const serverHost = privateEndpoint.hostname;
  const appBaseUrl = new URL(testInfo.project.use.baseURL as string);
  const appOrigin = `https://${APP_HOST}`;
  const edgeConfig = readFileSync(resolve('deploy/teagram-web/nginx.conf'), 'utf8');
  const edgeCsp = edgeConfig.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
  if(!edgeCsp) throw new Error('deployment CSP is missing from deploy/teagram-web/nginx.conf');

  const rsaPublicKey = createPublicKey(readFileSync(resolve('scripts/fixtures/private-mtproto-public.pem')));
  const discovery = {
    version: 1,
    mtproto: {
      endpoint: `${serverHost}:2443`,
      dc_id: 2,
      rsa_spki: rsaPublicKey.export({format: 'der', type: 'spki'}).toString('base64')
    },
    websocket: {endpoint: privateEndpoint.href}
  };
  const discoveryRequests: string[] = [];
  const unrelatedHttpsRequests: string[] = [];
  const unrelatedWebSocketUrl = webSocketFixture.unrelatedUrl;
  const context = page.context();
  await context.addInitScript((endpointUrl: string) => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        if(args[0] !== endpointUrl) return Reflect.construct(target, args, newTarget);
        const socket = new EventTarget() as EventTarget & {readyState: number, close: () => void};
        socket.readyState = 0;
        socket.close = () => {
          socket.readyState = 3;
          socket.dispatchEvent(new Event('close'));
        };
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.dispatchEvent(new Event('open'));
        });
        return socket;
      }
    });
  }, privateEndpoint.href);
  await context.route('**/*', async(route) => {
    const url = new URL(route.request().url());
    if(url.hostname === serverHost && url.pathname === '/.well-known/teagramd/client') {
      discoveryRequests.push(url.pathname);
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'content-type': 'application/json'
        },
        body: JSON.stringify(discovery)
      });
      return;
    }
    if(url.protocol === 'https:' && [APP_HOST, serverHost].includes(url.hostname)) {
      const upstreamUrl = new URL(`${url.pathname}${url.search}`, appBaseUrl.origin);
      const response = await route.fetch({url: upstreamUrl.href, headers: {host: appBaseUrl.host}});
      await route.fulfill({
        response,
        headers: {...response.headers(), 'content-security-policy': edgeCsp}
      });
      return;
    }
    await route.continue();
  });
  await context.route('https://unrelated.example.test/**', async(route) => {
    unrelatedHttpsRequests.push(route.request().url());
    await route.fulfill({status: 200, body: 'unexpected HTTPS request'});
  });
  const cspViolations: string[] = [];
  page.on('console', (message) => {
    if(message.type() === 'error' && /violates the following directive|Refused to .* because it violates/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });
  await page.goto(appOrigin, {waitUntil: 'domcontentloaded'});

  const picker = page.getByRole('dialog');
  await expect(picker.getByRole('heading', {name: 'Choose your server'})).toBeVisible();
  await picker.getByRole('textbox', {name: 'Server host'}).fill(serverHost);
  await picker.getByRole('button', {name: 'Continue'}).click();

  const confirmation = page.getByRole('dialog');
  await expect(confirmation.getByText(`Server: ${serverHost}`)).toBeVisible();
  expect(discoveryRequests).toEqual(['/.well-known/teagramd/client']);
  await confirmation.getByRole('button', {name: 'Confirm and use this server'}).click();

  const returningPicker = page.getByRole('dialog');
  await expect(returningPicker.getByRole('textbox', {name: 'Server host'})).toHaveValue(serverHost);
  await returningPicker.getByRole('button', {name: 'Continue'}).click();
  await expect(page.locator('meta[data-server-policy]'))
  .toHaveAttribute('content', `connect-src 'self' https://${serverHost} ${privateEndpoint.href};`);
  expect(await page.evaluate(() => (window as any).__TEAGRAM_ACTIVE_SERVER_HOST__)).toBe(serverHost);
  expect(discoveryRequests).toEqual(['/.well-known/teagramd/client', '/.well-known/teagramd/client']);
  expect(cspViolations).toEqual([]);
  await expectUnrelatedConnectionsBlocked(page, unrelatedHttpsRequests, webSocketFixture.unrelatedRequests, unrelatedWebSocketUrl);

  const pinnedPage = await context.newPage();
  const pinnedCspViolations: string[] = [];
  pinnedPage.on('console', (message) => {
    if(message.type() === 'error' && /violates the following directive|Refused to .* because it violates/i.test(message.text())) {
      pinnedCspViolations.push(message.text());
    }
  });
  await pinnedPage.goto(`https://${serverHost}`, {waitUntil: 'domcontentloaded'});
  await expect(pinnedPage.locator('meta[data-server-policy]'))
  .toHaveAttribute('content', `connect-src 'self' ${privateEndpoint.href};`);
  expect(await pinnedPage.getByRole('dialog').count()).toBe(0);
  expect(pinnedCspViolations).toEqual([]);
  await expectUnrelatedConnectionsBlocked(pinnedPage, unrelatedHttpsRequests, webSocketFixture.unrelatedRequests, unrelatedWebSocketUrl);
  await pinnedPage.close();
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
  let tlsSocketTracker: ReturnType<typeof trackTlsServerSockets> | undefined;
  let tlsResponseClosed = false;
  let tlsResponseClose: Promise<void> | undefined;
  const tlsResponseErrors: Error[] = [];
  const fixtureResponses = new Set<ServerResponse>();
  let webSocketServer: WebSocketServer | undefined;
  let tlsCleanupWait: string | undefined;
  const phaseDiagnostics: PhaseDiagnostic[] = [];
  const phaseTracker = createPhaseTracker((diagnostic) => {
    phaseDiagnostics.push(diagnostic);
    const description = JSON.stringify(diagnostic);
    console.info(`[custom-server-phase] ${description}`);
    testInfo.annotations.push({type: 'custom-server-phase', description});
  });
  const reportTlsLifecycle = (stage: string) => {
    console.info(`[custom-server-tls] ${JSON.stringify({
      stage,
      listening: tlsServer?.listening ?? false,
      clientResponseClosed: tlsResponseClosed,
      fixtureResponses: fixtureResponses.size,
      sockets: tlsSocketTracker?.snapshot() ?? {https: 0, websocket: 0},
      websocketClients: webSocketServer?.clients.size ?? 0
    })}`);
  };
  const phaseHeartbeat = setInterval(() => {
    phaseTracker.reportActive();
    if(tlsCleanupWait) reportTlsLifecycle(tlsCleanupWait);
  }, 5000);
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
      const credentials = createTlsFixtureCredentials(temporaryDirectory, [SERVER_HOST, APP_HOST]);

      // Both hosts resolve to this listener (see playwright.private-auth.config.ts) because
      // Playwright routing does not cover module imports inside the MTProto SharedWorker.
      webSocketServer = new WebSocketServer({noServer: true});
      tlsServer = createServer({
        key: readFileSync(credentials.privateKeyPath),
        cert: readFileSync(credentials.certificatePath)
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
        } else if(host === SERVER_HOST && url.pathname === '/__fixture/open-connection') {
          fixtureResponses.add(response);
          response.once('close', () => fixtureResponses.delete(response));
          holdTlsResponseOpen(response);
        } else if(host === SERVER_HOST && url.pathname === '/.well-known/teagramd/client') {
          void fetch(`${serverHttpUrl}/.well-known/teagramd/client`).then(async(upstreamResponse) => {
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
      tlsSocketTracker = trackTlsServerSockets(tlsServer);
      tlsServer.on('upgrade', (request, socket, head) => {
        tlsSocketTracker!.markUpgrade(socket);
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
      // Keep an HTTPS response open through sign-in so TLS teardown has a live connection to release.
      const tlsResponse = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = httpsRequest({
          host: '127.0.0.1',
          port: 18443,
          path: '/__fixture/open-connection',
          servername: SERVER_HOST,
          rejectUnauthorized: false,
          headers: {host: SERVER_HOST}
        }, resolve);
        request.once('error', reject);
        request.end();
      });
      tlsResponse.on('error', (error) => tlsResponseErrors.push(error));
      tlsResponseClose = new Promise<void>((resolve) => {
        tlsResponse.once('close', () => {
          tlsResponseClosed = true;
          resolve();
        });
      });
      tlsResponse.resume();

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

      const warmup = await customPage!.evaluate(async(username) => {
        const moduleUrl = new URL('/src/pages/privateUsernameAuth.ts', window.location.origin).href;
        const {authenticatePrivateUsername} = await import(moduleUrl);
        const apiManager = (window as any).rootScope.managers.apiManager;
        return authenticatePrivateUsername(username, (method: any, params: any, options?: any) => {
          return options ? apiManager.invokeApi(method, params, options) : apiManager.invokeApi(method, params);
        });
      }, SERVER_USER);
      expect(warmup).toMatchObject({kind: 'password'});
      expect(deleteUnboundCustomServerAuthKeys()).toBeGreaterThan(0);

      await auth.getByRole('textbox', {name: 'Username'}).fill(SERVER_USER);
      await auth.getByRole('button', {name: 'Next'}).click();

      const password = auth.locator('input[name="notsearch_password"]');
      await expect(password).toBeVisible({timeout: 30_000});
      await password.fill(SERVER_PASSWORD);
      await auth.getByRole('button', {name: 'Next'}).click();
      await expect(customPage!.locator('#page-chats')).toBeVisible({timeout: 60_000});
      expect(connections.length).toBeGreaterThan(0);
      expect(connections.every((origin) => origin === 'https://web.teagram.io')).toBe(true);
      expect(tlsResponseClosed).toBe(false);
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
      tlsCleanupWait = 'listener-close requested';
      reportTlsLifecycle(tlsCleanupWait);
      await closeTlsServer(server, tlsSocketTracker, (stage) => {
        tlsCleanupWait = `server.close ${stage}`;
        reportTlsLifecycle(tlsCleanupWait);
      });
      reportTlsLifecycle('listener and tracked socket shutdown resolved');
      tlsCleanupWait = 'held-response-close pending';
      reportTlsLifecycle(tlsCleanupWait);
      if(tlsResponseClose) await tlsResponseClose;
      tlsCleanupWait = 'connection-count verification pending';
      reportTlsLifecycle('held-response-close resolved');
      reportTlsLifecycle(tlsCleanupWait);
      if(server.listening) throw new Error('TLS fixture server remained open after cleanup');
      const remainingConnections = await getTlsConnectionCount(server);
      const remainingSockets = tlsSocketTracker?.snapshot() ?? {https: 0, websocket: 0};
      tlsCleanupWait = undefined;
      reportTlsLifecycle(`connection-count verified: ${remainingConnections}; sockets: ${JSON.stringify(remainingSockets)}`);
      if(remainingConnections) throw new Error(`TLS fixture retained ${remainingConnections} connections after cleanup`);
      if(remainingSockets.https || remainingSockets.websocket) throw new Error('TLS fixture retained sockets after cleanup');
    });
    await runCleanup('cleanup: remove temporary directory', () => {
      if(!temporaryDirectory) return;
      rmSync(temporaryDirectory, {recursive: true, force: true});
      if(existsSync(temporaryDirectory)) throw new Error('temporary TLS key directory remains after cleanup');
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
  expect(tlsResponseClosed).toBe(true);
  expect(hasOnlyConnectionResetErrors(tlsResponseErrors)).toBe(true);
  expect(phaseDiagnostics.every((diagnostic) => Object.keys(diagnostic).sort().join(',') === 'elapsedMs,lastCompletedPhase,phase,status')).toBe(true);
  expect(testInfo.annotations
    .filter((annotation) => annotation.type === 'custom-server-phase')
    .map((annotation) => annotation.description))
    .toEqual(phaseDiagnostics.map((diagnostic) => JSON.stringify(diagnostic)));
});
