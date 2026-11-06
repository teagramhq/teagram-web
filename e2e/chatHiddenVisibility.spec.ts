import {expect, test} from '@playwright/test';
import {setupRegistrationMocks} from './registrationMocks';

test('keeps the app manager chat invisible when hidden with the production styles', async({page}, testInfo) => {
  await setupRegistrationMocks(page, testInfo, 'open');
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const registration = page.locator('#auth-pages');
  await registration.getByRole('button', {name: 'Create account'}).click();
  await expect(registration.locator('input[aria-label="Display name"]')).toBeVisible();
  await registration.locator('input[aria-label="Username"]').fill('visibility_owner');
  await registration.locator('input[aria-label="Display name"]').fill('Visibility Test');
  await registration.locator('input[aria-label="Password"]').fill('Teagram-Test-Password-123!');
  await registration.locator('input[aria-label="Confirm password"]').fill('Teagram-Test-Password-123!');
  await registration.getByRole('button', {name: 'Create account'}).click();
  await expect(page.locator('#page-chats #chatlist-container')).toBeVisible({timeout: 30_000});
  await page.waitForFunction(() => {
    const container = (window as any).appImManager?.chat?.container;
    const hasChatStyles = Array.from(document.styleSheets).some((styleSheet) => {
      try {
        return Array.from(styleSheet.cssRules).some((rule) => 'selectorText' in rule && rule.selectorText === '.chat[hidden]');
      } catch{
        return false;
      }
    });

    return container?.isConnected && container.classList.contains('chat') && hasChatStyles;
  });

  const display = await page.evaluate(() => {
    const container = (window as any).appImManager.chat.container as HTMLElement;
    container.hidden = true;
    return getComputedStyle(container).display;
  });

  expect(display).toBe('none');
});
