import {expect, test} from '@playwright/test';
import {captureState, setupRegistrationMocks} from './registrationMocks';

test('retries phone sign-up with the Turnstile token and opens the account', async({page}, testInfo) => {
  const turnstileRequests: string[] = [];
  page.on('request', (request) => {
    if(request.url().includes('challenges.cloudflare.com')) turnstileRequests.push(request.url());
  });
  await setupRegistrationMocks(page, testInfo, 'open', true);

  await page.goto('/?noWorker=1', {waitUntil: 'domcontentloaded'});
  const registration = page.locator('#auth-pages');
  const phoneNumber = registration.locator('.input-field-phone [contenteditable="true"]');
  await expect(phoneNumber).toBeVisible({timeout: 30_000});
  await phoneNumber.fill('+12025550123');
  await registration.getByRole('button', {name: 'Next'}).click();

  const code = registration.locator('input[autocomplete="one-time-code"]');
  await expect(code).toBeVisible({timeout: 30_000});
  await code.fill('12345');

  const firstName = registration.locator('[contenteditable="true"]').first();
  await expect(firstName).toBeVisible({timeout: 30_000});
  await firstName.fill('CI Phone Signup');
  await registration.getByRole('button', {name: 'Start Messaging'}).click();

  const challenge = registration.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await expect(challenge).toHaveAttribute('data-sitekey', 'test-site-key');
  await expect(registration.getByRole('button', {name: 'Complete security check'})).toBeVisible();
  expect(await page.evaluate(() => (window as any).__turnstileCallbacks.action)).toBe('signup');
  await captureState(page, testInfo, 'standard-signup-turnstile');

  await registration.getByRole('button', {name: 'Complete security check'}).click();
  await expect(challenge.getByRole('alert')).toHaveText('The security check failed. Try again.');
  await registration.getByRole('button', {name: 'Try again'}).click();
  await registration.getByRole('button', {name: 'Complete security check'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'standard-signup-authorized');

  const calls = await page.evaluate(() => (window as any).__registrationCalls as Array<{
    method: string,
    params?: Record<string, any>
  }>);
  expect(calls.filter((call) => call.method.startsWith('auth.')).map((call) => call.method)).toEqual([
    'auth.sendCode',
    'auth.signIn',
    'auth.signUp'
  ]);
  const wrappedCalls = calls.filter((call) => call.method === 'invokeWithReCaptcha');
  expect(wrappedCalls).toHaveLength(2);
  const initialSignUp = calls.find((call) => call.method === 'auth.signUp')?.params;
  expect(initialSignUp).toMatchObject({first_name: 'CI Phone Signup', last_name: ''});
  expect(wrappedCalls[1].params).toMatchObject({
    token: 'synthetic-turnstile-token',
    query: {
      _: 'auth.signUp',
      phone_number: initialSignUp?.phone_number,
      first_name: 'CI Phone Signup',
      last_name: ''
    }
  });
  expect(calls.some((call) => call.method === 'apiManager.setUser')).toBe(true);
  expect(turnstileRequests).toHaveLength(1);
});
