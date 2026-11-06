import {expect, test} from '@playwright/test';

const AUTH_STATES = ['authCode', 'signUp', 'signQR', 'signImport', 'signIn'] as const;

test('private target keeps every unauthenticated state on username sign-in', async({page}, testInfo) => {
  await page.setViewportSize({width: 320, height: 720});
  const browserConsoleMessages: string[] = [];
  page.on('console', (message) => browserConsoleMessages.push(message.text()));

  const appOrigin = new URL(testInfo.project.use.baseURL as string).origin;
  await page.context().route('**/*', async(route) => {
    if(new URL(route.request().url()).origin === appOrigin) {
      await route.continue();
    } else {
      await route.abort();
    }
  });
  await page.context().routeWebSocket(/.*/, (socket) => {
    const url = new URL(socket.url());
    const origin = url.protocol === 'ws:' ? `http://${url.host}` : `https://${url.host}`;
    if(origin === appOrigin && url.pathname === '/') {
      socket.connectToServer();
    } else {
      socket.close();
    }
  });

  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const auth = page.locator('#auth-pages');
  await expect(auth).toBeAttached({timeout: 20_000});
  const initialUsername = auth.getByRole('textbox', {name: 'Username'});
  await expect(initialUsername).toBeVisible({timeout: 15_000});
  await expect(auth.getByText('Sign in with your username', {exact: true})).toBeVisible({timeout: 15_000});
  await page.waitForFunction(() => {
    const card = document.querySelector('#auth-pages input[aria-label="Username"]')?.closest('[class*="card"]');
    return !!card && getComputedStyle(card).opacity === '1' && card.getAnimations().length === 0;
  });
  const next = auth.getByRole('button', {name: 'Next'});
  for(let i = 0; i < 8 && !(await initialUsername.evaluate((input) => document.activeElement === input)); ++i) {
    await page.keyboard.press('Tab');
  }
  await expect(initialUsername).toBeFocused();
  const syntheticUsername = 'Alice_123';
  await initialUsername.fill(syntheticUsername);
  await expect(next).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await initialUsername.fill('');
  const freshScreenshot = testInfo.outputPath('private-auth-fresh-sign-in.png');
  await page.screenshot({path: freshScreenshot, fullPage: true});
  await testInfo.attach('private-auth-fresh-sign-in', {
    path: freshScreenshot,
    contentType: 'image/png'
  });

  for(const name of AUTH_STATES) {
    const username = auth.getByRole('textbox', {name: 'Username'});
    const previousCard = await username.evaluateHandle((input) => input.closest('[class*="card"]'));
    expect(await previousCard.evaluate((card) => !!card && card.isConnected)).toBe(true);

    await page.evaluate(async(name) => {
      const moduleUrl = new URL('/src/pages/authFlow.tsx', window.location.origin).href;
      const {navigateAuth} = await import(moduleUrl);
      switch(name) {
        case 'signIn':
          navigateAuth({name: 'signIn'});
          break;
        case 'authCode':
          navigateAuth({
            name: 'authCode',
            payload: {
              _: 'auth.sentCode',
              phone_code_hash: 'synthetic-code-hash',
              type: {_ : 'auth.sentCodeTypeApp', length: 5},
              timeout: 60
            }
          });
          break;
        case 'signUp':
          navigateAuth({
            name: 'signUp',
            payload: {phone_number: '+12025550123', phone_code_hash: 'synthetic-code-hash'}
          });
          break;
        case 'signQR':
          navigateAuth({name: 'signQR'});
          break;
        case 'signImport':
          navigateAuth({
            name: 'signImport',
            payload: {token: 'synthetic-token', userId: 1, dcId: 1, isTest: false, tgAddr: ''}
          });
          break;
      }
    }, name);

    await expect.poll(
      () => previousCard.evaluate((card) => !card || !card.isConnected),
      {message: `previous auth card should detach after forcing ${name}`}
    ).toBe(true);
    await previousCard.dispose();

    const replacementUsername = auth.getByRole('textbox', {name: 'Username'});
    await expect(replacementUsername).toBeVisible();
    await expect(auth.getByText('Sign in with your username', {exact: true})).toBeVisible();
    await page.waitForFunction(() => {
      const card = document.querySelector('#auth-pages input[aria-label="Username"]')?.closest('[class*="card"]');
      return !!card && getComputedStyle(card).opacity === '1' && card.getAnimations().length === 0;
    });
    await expect(auth.locator('input[type="tel"], input[aria-label*="phone number" i], canvas, a')).toHaveCount(0);
    await expect(auth.getByText(/phone number|qr code|sign up|create account/i)).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewportHeight: document.documentElement.clientHeight
    }));
    expect(dimensions.width).toBeLessThanOrEqual(320);
    expect(dimensions.height).toBeLessThanOrEqual(dimensions.viewportHeight);

    const screenshot = testInfo.outputPath(`private-auth-${name}.png`);
    await page.screenshot({path: screenshot, fullPage: true});
    await testInfo.attach(`private-auth-${name}`, {
      path: screenshot,
      contentType: 'image/png'
    });
  }

  expect(browserConsoleMessages.join('\n')).not.toContain(syntheticUsername);
});

test('paints a saved chat page before the first worker page and replaces it', async({page}, testInfo) => {
  const appOrigin = new URL(testInfo.project.use.baseURL as string).origin;
  await page.context().route('**/*', async(route) => {
    if(new URL(route.request().url()).origin === appOrigin) await route.continue();
    else await route.abort();
  });
  await page.context().routeWebSocket(/.*/, (socket) => {
    const url = new URL(socket.url());
    const origin = url.protocol === 'ws:' ? `http://${url.host}` : `https://${url.host}`;
    if(origin === appOrigin && url.pathname === '/') socket.connectToServer();
    else socket.close();
  });
  await page.addInitScript(() => {
    const gate = (window as any).__snapshotBootGate = {
      enabled: localStorage.getItem('__snapshot-boot-gate') === '1',
      firstPageRequested: false,
      firstPageCompleted: false,
      releaseFirstPage: undefined as (() => void) | undefined
    };
    Object.defineProperty(window, 'apiManagerProxy', {
      configurable: true,
      set(proxy: any) {
        delete (window as any).apiManagerProxy;
        (window as any).apiManagerProxy = proxy;
        const invoke = proxy.invoke.bind(proxy);
        proxy.invoke = (type: string, payload: any, ...args: any[]) => {
          if(gate.enabled && !gate.firstPageRequested && type === 'manager' &&
            payload?.name === 'dialogsStorage' && payload.method === 'getDialogs' && !payload.args?.[0]?.offsetIndex) {
            gate.firstPageRequested = true;
            return new Promise((resolve) => {
              gate.releaseFirstPage = () => {
                resolve({cached: true, result: Promise.resolve({dialogs: [], count: 0, isEnd: true})});
              };
            });
          }
          return invoke(type, payload, ...args);
        };
      }
    });
  });

  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  await expect(page.locator('#auth-pages')).toBeAttached({timeout: 20_000});
  await page.evaluate(async() => {
    const moduleUrl = (path: string) => new URL(path, window.location.origin).href;
    const sessionStorage = (await import(moduleUrl('/src/lib/sessionStorage.ts'))).default;
    const snapshots = await import(moduleUrl('/src/lib/chatPageSnapshot.ts'));
    await sessionStorage.set({account1: {
      userId: 787878,
      dcId: 2,
      dc2_auth_key: 'ab'.repeat(256),
      dc2_server_salt: '00'.repeat(8)
    }} as any);
    const key = await snapshots.getChatPageKey(1);
    if(!key) throw new Error('Failed to create the private signed-in fixture account');
    const epoch = await snapshots.captureChatPageSnapshotEpoch(1);
    await snapshots.writeChatPageSnapshot(key, [{
      peerId: 424242 as PeerId,
      title: 'Saved preview fixture',
      preview: 'Painted before live dialogs',
      date: 1,
      unread: 0,
      markedUnread: false,
      muted: false,
      pinned: false
    }], epoch);
    localStorage.setItem('__snapshot-boot-gate', '1');
  });

  await page.reload({waitUntil: 'domcontentloaded'});
  const savedRow = page.locator('.chat-page-snapshot .chatlist-chat');
  await expect(savedRow).toHaveCount(1, {timeout: 20_000});
  await expect(savedRow).toContainText('Saved preview fixture');
  await expect(savedRow).toContainText('Painted before live dialogs');
  await page.evaluate(() => {
    const gate = (window as any).__snapshotBootGate;
    const firstPage = (window as any).apiManagerProxy.invoke('manager', {
      name: 'dialogsStorage',
      method: 'getDialogs',
      args: [{offsetIndex: 0, limit: 20, filterId: 0, snapshot: true, skipMigrated: true}]
    });
    void firstPage.then(async(acked: any) => {
      await acked.result;
      const moduleUrl = new URL('/src/lib/chatPageSnapshotView.ts', window.location.origin).href;
      const {replaceChatPageSnapshot} = await import(moduleUrl);
      replaceChatPageSnapshot();
      gate.firstPageCompleted = true;
    });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__snapshotBootGate.firstPageRequested)).toBe(true);
  expect(await page.evaluate(() => (window as any).__snapshotBootGate.firstPageCompleted)).toBe(false);

  await page.evaluate(() => (window as any).__snapshotBootGate.releaseFirstPage());
  await expect(page.locator('.chat-page-snapshot')).toHaveCount(0, {timeout: 30_000});
  await expect.poll(() => page.evaluate(() => (window as any).__snapshotBootGate.firstPageCompleted)).toBe(true);
});
