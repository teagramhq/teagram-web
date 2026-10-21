import {expect, test} from '@playwright/test';
import {captureState, setupRegistrationMocks} from './registrationMocks';

test('protects username sign-in with a signin Turnstile challenge', async({page}, testInfo) => {
  await setupRegistrationMocks(page, testInfo, 'open', false, false, true);

  await page.goto('/?noWorker=1', {waitUntil: 'domcontentloaded'});
  const auth = page.locator('#auth-pages');
  const username = auth.getByRole('textbox', {name: 'Username'});
  await expect(username).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'signin-before-challenge');
  await username.fill('Alice_123');
  await auth.getByRole('button', {name: 'Next'}).click();

  const challenge = auth.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await expect(challenge).toHaveAttribute('data-sitekey', 'test-site-key');
  await expect(challenge.getByRole('status')).toContainText('Loading security check');
  await captureState(page, testInfo, 'signin-challenge-loading');
  await expect(challenge.getByRole('button', {name: 'Complete security check'})).toBeVisible();
  await captureState(page, testInfo, 'signin-challenge-ready');
  expect(await page.evaluate(() => (window as any).__turnstileCallbacks.action)).toBe('signin');
  await challenge.getByRole('button', {name: 'Complete security check'}).click();
  await expect(challenge.getByRole('alert')).toBeVisible();
  await expect(challenge.getByRole('button', {name: /try again/i})).toBeVisible();
  await captureState(page, testInfo, 'signin-challenge-rejected');
  await challenge.getByRole('button', {name: /try again/i}).click();
  await expect(challenge.getByRole('button', {name: 'Complete security check'})).toBeVisible();
  await captureState(page, testInfo, 'signin-challenge-retried');
  await challenge.getByRole('button', {name: 'Complete security check'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'signin-complete');

  const calls = await page.evaluate(() => (window as any).__registrationCalls as Array<{
    method: string,
    params?: Record<string, any>
  }>);
  const wrappedSendCodes = calls.filter((call) => call.method === 'invokeWithReCaptcha' && call.params?.query?._ === 'auth.sendCode');
  const directSendCode = calls.find((call) => call.method === 'auth.sendCode');
  expect(wrappedSendCodes).toHaveLength(2);
  expect(wrappedSendCodes[0].params).toMatchObject({
    token: expect.any(String),
    query: {_: 'auth.sendCode', phone_number: 'Alice_123'}
  });
  expect(wrappedSendCodes[1].params).toMatchObject({
    token: expect.any(String),
    query: {_: 'auth.sendCode', phone_number: 'Alice_123'}
  });
  expect(wrappedSendCodes[0].params?.token).not.toBe(wrappedSendCodes[1].params?.token);
  expect(directSendCode?.params).toMatchObject({phone_number: 'Alice_123'});
  expect(calls.indexOf(directSendCode!)).toBeLessThan(calls.indexOf(wrappedSendCodes[0]));
  expect(calls.some((call) => call.method === 'auth.signIn')).toBe(true);
  expect(calls.some((call) => call.method === 'invokeWithReCaptcha' && call.params?.query?._ === 'auth.signIn')).toBe(false);
});
