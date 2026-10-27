import type {Page, TestInfo} from '@playwright/test';

export async function setupRegistrationMocks(
  page: Page,
  testInfo: TestInfo,
  mode: 'open' | 'invite',
  requireTurnstile = false,
  failFirstTurnstileScript = false,
  requireSignInTurnstile = false,
  requirePasswordTurnstile = false,
  termsText?: string,
  takenUsername?: string,
  delayAuthResponse = false,
  reservedUsername?: string
) {
  const appOrigin = new URL(testInfo.project.use.baseURL as string).origin;
  let turnstileScriptAttempts = 0;

  await page.context().route('**/*', async(route) => {
    const url = new URL(route.request().url());
    if(url.origin === appOrigin) {
      await route.continue();
    } else if((requireTurnstile || requireSignInTurnstile || requirePasswordTurnstile) && url.hostname === 'challenges.cloudflare.com') {
      turnstileScriptAttempts++;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if(failFirstTurnstileScript && turnstileScriptAttempts === 1) {
        await route.abort();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
          let turnstileTokenCount = 0;
          window.turnstile = {
            render(container, callbacks) {
              window.__turnstileCallbacks = callbacks;
              const complete = document.createElement('button');
              complete.type = 'button';
              complete.textContent = 'Complete security check';
              complete.onclick = () => callbacks.callback(turnstileTokenCount++ ? 'synthetic-turnstile-token' : 'rejected-turnstile-token');
              const expire = document.createElement('button');
              expire.type = 'button';
              expire.textContent = 'Expire security check';
              expire.onclick = () => callbacks['expired-callback']();
              container.append(complete, expire);
              return 'test-widget';
            },
            reset() {},
            remove() {}
          };
        `
      });
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
  await page.addInitScript((options) => {
    Object.defineProperty(window, 'apiManagerProxy', {
      configurable: true,
      set(proxy: any) {
        delete (window as any).apiManagerProxy;
        (window as any).apiManagerProxy = proxy;
        const invoke = proxy.invoke.bind(proxy);
        const calls: Array<{method: string, params?: Record<string, unknown>}> =
          ((window as any).__registrationCalls = []);
        const user = {_ : 'user', id: 4242, first_name: 'CI Registration'};

        proxy.invoke = (type: string, payload: any, ...args: any[]) => {
          if(type === 'manager' && payload?.name === 'apiManager') {
            if(payload.method === 'getAppConfig') {
              const config = {
                registration_mode: options.registrationMode,
                ...(options.requireSignInTurnstile || options.requirePasswordTurnstile ? {turnstile: {site_key: 'test-site-key'}} : {})
              };
              calls.push({method: 'help.getAppConfig', params: config});
              return Promise.resolve(config);
            }

            if(payload.method === 'invokeApi') {
              const [method, params] = payload.args;
              calls.push({method, params});
              switch(method) {
                case 'auth.sendCode':
                  if(options.delayAuthResponse) {
                    return new Promise((resolve) => window.setTimeout(() => resolve({
                      _: 'auth.sentCode',
                      phone_code_hash: 'mock-registration-code-hash',
                      type: {_ : 'auth.sentCodeTypeApp', length: 5},
                      timeout: 60
                    }), 400));
                  }
                  if(options.requireSignInTurnstile) {
                    return Promise.reject({type: 'RECAPTCHA_CHECK_signin__test-site-key'});
                  }
                  return Promise.resolve({
                    _: 'auth.sentCode',
                    phone_code_hash: 'mock-registration-code-hash',
                    type: {_ : 'auth.sentCodeTypeApp', length: 5},
                    timeout: 60
                  });
                case 'auth.signIn':
                  if(options.requireSignInTurnstile) return Promise.resolve({_ : 'auth.authorization', user});
                  if(options.requirePasswordTurnstile) return Promise.reject({type: 'SESSION_PASSWORD_NEEDED'});
                  return Promise.resolve({_ : 'auth.authorizationSignUpRequired', terms_of_service: options.termsText ? {
                    _: 'help.termsOfService',
                    id: {_ : 'dataJSON', data: '{"terms":"registration"}'},
                    text: options.termsText,
                    entities: [],
                    pFlags: {popup: true}
                  } : {}});
                case 'auth.checkPassword':
                  if(options.requirePasswordTurnstile) return Promise.reject({type: 'RECAPTCHA_CHECK_signin__test-site-key'});
                  return Promise.reject({type: 'PASSWORD_HASH_INVALID'});
                case 'auth.signUp':
                  if(options.requireTurnstile) {
                    return Promise.reject({type: 'RECAPTCHA_CHECK_signup__test-site-key'});
                  }
                  if(options.reservedUsername === params?.phone_number) return Promise.reject({type: 'USERNAME_INVALID'});
                  if(options.takenUsername === params?.phone_number) return Promise.reject({type: 'USERNAME_OCCUPIED'});
                  return Promise.resolve({_ : 'auth.authorization', user});
                case 'help.getNearestDc':
                  return Promise.resolve({_ : 'nearestDc', country: 'US', this_dc: 1, nearest_dc: 1});
                case 'invokeWithReCaptcha':
                  if(params?.query?._ === 'auth.checkPassword') {
                    if(params.token === 'rejected-turnstile-token') {
                      return Promise.reject({type: 'RECAPTCHA_CHECK_signin__test-site-key'});
                    }
                    return Promise.resolve({_ : 'auth.authorization', user});
                  }
                  if(params?.query?._ === 'auth.sendCode') {
                    if(params.token === 'rejected-turnstile-token') {
                      return Promise.reject({type: 'RECAPTCHA_CHECK_signin__test-site-key'});
                    }
                    return Promise.resolve({
                      _: 'auth.sentCode',
                      phone_code_hash: 'mock-registration-code-hash',
                      type: {_ : 'auth.sentCodeTypeApp', length: 5},
                      timeout: 60
                    });
                  }
                  if(calls.filter((call) => call.method === 'invokeWithReCaptcha').length === 1) {
                    return new Promise((_resolve, reject) => {
                      window.setTimeout(() => reject({type: 'RECAPTCHA_CHECK_signup__test-site-key'}), 800);
                    });
                  }
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
  }, {registrationMode: mode, requireTurnstile, requireSignInTurnstile, requirePasswordTurnstile, termsText, takenUsername, delayAuthResponse, reservedUsername});
}

export async function captureState(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({path, fullPage: true});
  await testInfo.attach(name, {path, contentType: 'image/png'});
}
