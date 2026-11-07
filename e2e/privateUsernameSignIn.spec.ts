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
  const livePeerId = 424243;
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
      dialogsRequests: 0,
      requests: [] as Array<{taskId: number, args: unknown, responses: unknown[]}>,
      preloadRequested: false,
      firstPageRequested: false,
      releasePreload: undefined as (() => void) | undefined,
      releaseFirstPage: undefined as (() => void) | undefined
    };
    const postMessage = MessagePort.prototype.postMessage as (this: MessagePort, message: any, options?: any) => void;
    const isDialogsRequest = (task: any) => task?.type === 'invoke' &&
      task.payload?.type === 'manager' &&
      task.payload.payload?.name === 'dialogsStorage' &&
      task.payload.payload.method === 'getDialogs';
    const isFirstPageRequest = (task: any) => isDialogsRequest(task) &&
      task.payload.payload.args?.[0]?.snapshot === true &&
      (task.payload.payload.args?.[0]?.filterId ?? 0) === 0 &&
      !task.payload.payload.args?.[0]?.offsetIndex;
    MessagePort.prototype.postMessage = function(this: MessagePort, message: any, transfer?: any) {
      if(!gate.enabled) return postMessage.call(this, message, transfer);
      const tasks = message?.type === 'batch' ? message.payload : [message];
      const firstPageIndex = tasks.findIndex(isFirstPageRequest);
      if(firstPageIndex < 0) return postMessage.call(this, message, transfer);

      gate.dialogsRequests++;
      const port = this;
      const firstPageTask = tasks[firstPageIndex];
      const request = {
        taskId: firstPageTask.id,
        args: firstPageTask.payload.payload.args?.[0],
        responses: [] as unknown[]
      };
      gate.requests.push(request);
      port.addEventListener('message', (event: MessageEvent) => {
        const incomingTasks = event.data?.type === 'batch' ? event.data.payload : [event.data];
        for(const incomingTask of incomingTasks) {
          if(!['ack', 'result'].includes(incomingTask?.type) || incomingTask.payload?.taskId !== request.taskId) continue;
          const result = incomingTask.type === 'ack' && incomingTask.payload.cached ? incomingTask.payload.result : incomingTask.payload.result;
          request.responses.push({type: incomingTask.type, cached: incomingTask.payload.cached, dialogPeerIds: result?.dialogs?.map((dialog: any) => dialog.peerId)});
        }
      });
      const remainingTasks = tasks.filter((_: any, index: number) => index !== firstPageIndex);
      if(message?.type === 'batch' && remainingTasks.length) {
        postMessage.call(port, {...message, payload: remainingTasks}, transfer);
      }
      const release = () => postMessage.call(port, firstPageTask, transfer);
      if(gate.dialogsRequests === 1) {
        gate.preloadRequested = true;
        gate.releasePreload = release;
        return;
      }
      if(gate.dialogsRequests === 2) {
        gate.firstPageRequested = true;
        gate.releaseFirstPage = release;
        return;
      }

      return release();
    } as typeof MessagePort.prototype.postMessage;
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
    const {default: apiManagerProxy} = await import(moduleUrl('/src/lib/apiManagerProxy.ts'));
    const filter = (id: number) => ({
      _: 'dialogFilter',
      id,
      title: {_: 'textWithEntities', text: `Fixture ${id}`, entities: [] as any[]},
      pFlags: {},
      pinned_peers: [] as any[],
      include_peers: [] as any[],
      exclude_peers: [] as any[],
      localId: id
    });
    await apiManagerProxy.invoke('manager', {
      name: 'appStateManager',
      method: 'pushToState',
      accountNumber: 1,
      args: ['filtersArr', [filter(0), filter(1), filter(2)]]
    });
    localStorage.setItem('__snapshot-boot-gate', '1');
  });

  await page.reload({waitUntil: 'domcontentloaded'});
  const savedRow = page.locator('.chat-page-snapshot .chatlist-chat');
  await expect(savedRow).toHaveCount(1, {timeout: 20_000});
  await expect(savedRow).toContainText('Saved preview fixture');
  await expect(savedRow).toContainText('Painted before live dialogs');
  const snapshotScreenshot = testInfo.outputPath('chat-page-snapshot.png');
  await page.screenshot({path: snapshotScreenshot});
  await testInfo.attach('chat-page-snapshot', {path: snapshotScreenshot, contentType: 'image/png'});
  await expect.poll(() => page.evaluate(() => (window as any).__snapshotBootGate.preloadRequested), {timeout: 30_000}).toBe(true);
  await page.evaluate(async(livePeerId) => {
    const moduleUrl = (path: string) => new URL(path, window.location.origin).href;
    const {default: apiManagerProxy} = await import(moduleUrl('/src/lib/apiManagerProxy.ts'));
    await apiManagerProxy.invoke('manager', {
      name: 'dialogsStorage',
      method: 'applyDialogs',
      accountNumber: 1,
      args: [{
        _: 'messages.dialogs',
        dialogs: [{
          _: 'dialog',
          peer: {_: 'peerUser', user_id: livePeerId},
          top_message: 1,
          read_inbox_max_id: 1,
          read_outbox_max_id: 1,
          unread_count: 0,
          notify_settings: {_: 'peerNotifySettings', pFlags: {}},
          folder_id: 0,
          pFlags: {}
        }],
        users: [{
          _: 'user',
          id: 787878,
          access_hash: '1',
          first_name: 'Snapshot fixture owner',
          last_name: '',
          phone: '',
          pFlags: {contact: true}
        }, {
          _: 'user',
          id: livePeerId,
          access_hash: '2',
          first_name: 'Live worker fixture',
          last_name: '',
          phone: '',
          pFlags: {contact: true}
        }],
        chats: [],
        messages: [{
          _: 'message',
          id: 1,
          peer_id: {_: 'peerUser', user_id: livePeerId},
          from_id: {_: 'peerUser', user_id: livePeerId},
          date: 1,
          message: 'First page live preview',
          pFlags: {}
        }]
      }]
    });
    const dialog = await apiManagerProxy.invoke('manager', {
      name: 'dialogsStorage',
      method: 'getDialogOnly',
      accountNumber: 1,
      args: [livePeerId]
    });
    await apiManagerProxy.invoke('manager', {
      name: 'dialogsStorage',
      method: 'processDialogForFilters',
      accountNumber: 1,
      args: [dialog]
    });
    await apiManagerProxy.invoke('manager', {
      name: 'dialogsStorage',
      method: 'setDialogsLoaded',
      accountNumber: 1,
      args: [0, true]
    });
    await apiManagerProxy.invoke('manager', {
      name: 'appPeersManager',
      method: 'mirrorApiPeers',
      accountNumber: 1,
      args: [[String(787878), String(livePeerId)]]
    });
  }, livePeerId);

  await expect(savedRow).toHaveCount(1);
  await expect(page.locator('#folders-container .chatlist-chat')).toHaveCount(0);
  await page.evaluate(() => (window as any).__snapshotBootGate.releasePreload());
  await expect.poll(() => page.evaluate(() => (window as any).__snapshotBootGate.firstPageRequested), {timeout: 20_000}).toBe(true);
  await expect(savedRow).toHaveCount(1);
  await expect(page.locator('#folders-container .chatlist-chat')).toHaveCount(0);
  await page.evaluate(async() => {
    const moduleUrl = (path: string) => new URL(path, window.location.origin).href;
    const {default: apiManagerProxy} = await import(moduleUrl('/src/lib/apiManagerProxy.ts'));
    (apiManagerProxy as any).appConfig = {premium_purchase_blocked: false};
  });
  await page.evaluate(() => (window as any).__snapshotBootGate.releaseFirstPage());
  await expect.poll(() => page.evaluate(() => {
    const request = (window as any).__snapshotBootGate.requests[1];
    return request?.responses.some((response: any) => response.dialogPeerIds?.includes(424243)) || false;
  })).toBe(true);
  await expect(page.locator('.chat-page-snapshot')).toHaveCount(0, {timeout: 30_000});
  const liveRow = page.locator('#folders-container .chatlist-chat');
  await expect(liveRow).toHaveCount(1, {timeout: 30_000});
  await expect(liveRow).toContainText('Live worker fixture');
  await expect(liveRow).toContainText('First page live preview');
  await page.waitForFunction(() => {
    const row = document.querySelector<HTMLElement>('#folders-container .chatlist-chat');
    return !!row && Number(getComputedStyle(row).opacity) >= 0.99;
  });
  const liveScreenshot = testInfo.outputPath('chat-page-live.png');
  await page.screenshot({path: liveScreenshot});
  await testInfo.attach('chat-page-live', {path: liveScreenshot, contentType: 'image/png'});
});
