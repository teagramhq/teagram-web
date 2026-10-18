import {expect, test} from '@playwright/test';

for(const mode of ['open', 'invite'] as const) {
  test(`registers a username account in ${mode} mode without a live server`, async({page}, testInfo) => {
    const appOrigin = new URL(testInfo.project.use.baseURL as string).origin;
    const username = mode === 'open' ? 'test_user_open' : 'test_user_invite';
    const inviteSecret = 'test-invite-secret';
    const password = 'Teagram-Test-Password-123!';

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
    await page.addInitScript((registrationMode) => {
      Object.defineProperty(window, 'apiManagerProxy', {
        configurable: true,
        set(proxy: any) {
          delete (window as any).apiManagerProxy;
          (window as any).apiManagerProxy = proxy;
          const invoke = proxy.invoke.bind(proxy);
          const calls: Array<{method: string, params?: Record<string, unknown>}> =
            ((window as any).__privateRegistrationCalls = []);
          const user = {_ : 'user', id: 4242, first_name: 'CI Registration'};

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
    }, mode);

    await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
    const registration = page.locator('#auth-pages');
    await expect(registration.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
    await expect(registration.getByRole('button', {name: 'Create account'})).toBeVisible({timeout: 30_000});
    await registration.getByRole('button', {name: 'Create account'}).click();

    await registration.locator('input[aria-label="Username"]').fill(username);
    await registration.locator('input[aria-label="Display name"]').fill('CI Registration');
    await registration.locator('input[aria-label="Password"]').fill(password);
    await registration.locator('input[aria-label="Confirm password"]').fill(password);
    if(mode === 'invite') {
      await registration.locator('input[aria-label="Invite secret"]').fill(inviteSecret);
    } else {
      await expect(registration.locator('input[aria-label="Invite secret"]')).toHaveCount(0);
    }

    await registration.getByRole('button', {name: 'Create account'}).click();
    await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});

    const calls = await page.evaluate(() => (window as any).__privateRegistrationCalls as Array<{
      method: string,
      params?: Record<string, unknown>
    }>);
    expect(calls.some((call) => call.method === 'help.getAppConfig' && call.params?.registration_mode === mode)).toBe(true);
    expect(calls.filter((call) => call.method.startsWith('auth.')).map((call) => call.method)).toEqual([
      'auth.sendCode',
      'auth.signIn',
      'auth.signUp'
    ]);
    expect(calls.find((call) => call.method === 'auth.signIn')?.params?.phone_code).toBe(mode === 'invite' ? inviteSecret : '');
    expect(calls.find((call) => call.method === 'auth.signUp')?.params).toMatchObject({
      phone_number: username,
      first_name: 'CI Registration',
      last_name: ''
    });
    expect(calls.find((call) => call.method === 'account.updatePasswordSettings')?.params).toEqual({newPassword: password});
    expect(calls.some((call) => call.method === 'apiManager.setUser')).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).apiManagerProxy.getUser(4242))).toMatchObject({
      _: 'user',
      id: 4242,
      first_name: 'CI Registration'
    });
  });
}
