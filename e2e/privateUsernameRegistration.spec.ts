import {randomBytes} from 'node:crypto';
import {expect, test} from '@playwright/test';

test.skip(process.env.TWEB_REGISTRATION_E2E !== '1', 'account registration runs against the CI server');

test('registers a fresh username account and signs in again', async({browser, page}, testInfo) => {
  test.setTimeout(120_000);

  const username = `qa${Date.now().toString(36)}${randomBytes(4).toString('hex')}`.toLowerCase();
  const password = `Teagram-${randomBytes(24).toString('base64url')}!`;
  const displayName = `CI user ${Date.now()}`;
  const appURL = testInfo.project.use.baseURL as string;

  await page.goto('/?noWorker=1', {waitUntil: 'domcontentloaded'});
  const registration = page.locator('#auth-pages');
  await expect(registration.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await expect(registration.getByRole('button', {name: 'Create account'})).toBeVisible({timeout: 30_000});
  await registration.getByRole('button', {name: 'Create account'}).click();

  await registration.locator('input[aria-label="Username"]').fill(username);
  await registration.locator('input[aria-label="Display name"]').fill(displayName);
  await registration.locator('input[aria-label="Password"]').fill(password);
  await registration.locator('input[aria-label="Confirm password"]').fill(password);
  await expect(registration.locator('input[aria-label="Invite secret"]')).toHaveCount(0);
  await registration.getByRole('button', {name: 'Create account'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 60_000});

  const signInContext = await browser.newContext({
    baseURL: appURL,
    viewport: {width: 320, height: 720}
  });
  try {
    const signInPage = await signInContext.newPage();
    await signInPage.goto('/?noWorker=1', {waitUntil: 'domcontentloaded'});
    const auth = signInPage.locator('#auth-pages');
    const usernameInput = auth.getByRole('textbox', {name: 'Username'});
    await expect(usernameInput).toBeVisible({timeout: 30_000});
    await usernameInput.fill(username);
    await auth.getByRole('button', {name: 'Next'}).click();

    const passwordInput = auth.locator('input[aria-label="LoginPassword"]');
    await expect(passwordInput).toBeVisible({timeout: 30_000});
    await passwordInput.fill(password);
    await auth.getByRole('button', {name: 'Next'}).click();
    await expect(signInPage.locator('#page-chats')).toBeVisible({timeout: 60_000});
  } finally {
    await signInContext.close();
  }
});
