import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';
import {captureState} from './registrationMocks';

const turnstileScript = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

async function installTurnstileMock(page: Page) {
  await page.route(turnstileScript, async(route) => {
    await page.waitForTimeout(250);
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.turnstile = {
      render(container, callbacks) {
        window.__turnstileCallbacks = callbacks;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Complete security check';
        button.addEventListener('click', () => callbacks.callback('synthetic-turnstile-token'));
        container.append(button);
        return 'test-widget';
      },
      reset() {},
      remove() {}
    };`
    });
  });
}

test('hands a challenge token to the desktop bridge exactly once', async({page}, testInfo) => {
  await page.addInitScript(() => {
    (window as any).__desktopTurnstileEvents = [];
    (window as any).TelegramWebviewProxy = {
      postEvent(name: string, payload: string) {
        (window as any).__desktopTurnstileEvents.push({name, payload});
      }
    };
  });
  await installTurnstileMock(page);

  await page.goto('/turnstile.html#sitekey=desktop-test-key&action=signup', {waitUntil: 'domcontentloaded'});
  await expect(page.getByRole('heading', {name: 'Security check'})).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Loading security check…');
  await expect(page.getByRole('button', {name: 'Complete security check'})).toBeVisible();
  await captureState(page, testInfo, 'desktop-turnstile-ready');

  const complete = page.getByRole('button', {name: 'Complete security check'});
  await complete.focus();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('status')).toHaveText('Checking…');
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTurnstileEvents)).toEqual([{
    name: 'turnstile_token',
    payload: '{"token":"synthetic-turnstile-token","action":"signup"}'
  }]);
  await expect(page.locator('#turnstile-widget')).toBeEmpty();
  await captureState(page, testInfo, 'desktop-turnstile-token-sent');
});

test('does not load Turnstile when opened without the desktop bridge', async({page}) => {
  const turnstileRequests: string[] = [];
  page.on('request', (request) => {
    if(request.url().startsWith('https://challenges.cloudflare.com/')) turnstileRequests.push(request.url());
  });

  await page.goto('/turnstile.html#sitekey=desktop-test-key&action=signin');

  await expect(page.getByRole('status')).toHaveText('Open this security check from Teagram Desktop.');
  expect(turnstileRequests).toEqual([]);
});
