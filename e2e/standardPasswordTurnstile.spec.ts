import {expect, test} from '@playwright/test';
import {captureState, setupRegistrationMocks} from './registrationMocks';

test('retries standard phone 2FA with the Turnstile token', async({page}, testInfo) => {
  await setupRegistrationMocks(page, testInfo, 'open', false, false, false, true);

  await page.goto('/?noWorker=1', {waitUntil: 'domcontentloaded'});
  const auth = page.locator('#auth-pages');
  const phoneNumber = auth.locator('.input-field-phone [contenteditable="true"]');
  await expect(phoneNumber).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'standard-phone-signin');
  await phoneNumber.fill('+12025550123');
  await auth.getByRole('button', {name: 'Next'}).click();

  const code = auth.locator('input[autocomplete="one-time-code"]');
  await expect(code).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'standard-phone-code');
  await code.fill('12345');

  const password = auth.locator('input[name="notsearch_password"]');
  await expect(password).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'standard-phone-password');
  await page.setViewportSize({width: 1280, height: 800});
  await expect(password).toBeInViewport();
  await captureState(page, testInfo, 'standard-phone-password-wide');
  await page.setViewportSize({width: 412, height: 915});

  await password.fill('mock-password');
  await password.press('Enter');
  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await expect(challenge.locator('[role="status"]')).toBeVisible();
  await expect(auth.locator('button.btn-primary')).toBeDisabled();
  await captureState(page, testInfo, 'standard-phone-turnstile-loading');
  await expect(challenge.getByRole('button', {name: 'Complete security check'})).toBeVisible();
  expect(await page.evaluate(() => (window as any).__turnstileCallbacks.action)).toBe('signin');
  await captureState(page, testInfo, 'standard-phone-turnstile-ready');

  const complete = challenge.getByRole('button', {name: 'Complete security check'});
  await complete.focus();
  await page.keyboard.press('Enter');
  await expect(challenge.getByRole('alert')).toHaveText('The security check failed. Try again.');
  await captureState(page, testInfo, 'standard-phone-turnstile-retry');
  const retry = challenge.getByRole('button', {name: 'Try again'});
  await retry.focus();
  await page.keyboard.press('Enter');
  await complete.focus();
  await page.keyboard.press('Enter');

  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'standard-phone-authorized');

  const calls = await page.evaluate(() => (window as any).__registrationCalls as Array<{
    method: string,
    params?: Record<string, any>
  }>);
  const checkPassword = calls.find((call) => call.method === 'auth.checkPassword');
  expect(checkPassword?.params).toMatchObject({
    password: {_ : 'inputCheckPasswordSRP', srp_id: '1'}
  });
  const wrappedCheckPassword = calls.filter((call) => call.method === 'invokeWithReCaptcha' && call.params?.query?._ === 'auth.checkPassword');
  expect(wrappedCheckPassword).toHaveLength(2);
  expect(wrappedCheckPassword[0].params).toMatchObject({token: 'rejected-turnstile-token'});
  expect(wrappedCheckPassword[1].params).toMatchObject({
    token: 'synthetic-turnstile-token',
    query: {
      _: 'auth.checkPassword',
      password: {_ : 'inputCheckPasswordSRP', srp_id: '1'}
    }
  });
  expect(calls.some((call) => call.method === 'apiManager.setUser')).toBe(true);
});
