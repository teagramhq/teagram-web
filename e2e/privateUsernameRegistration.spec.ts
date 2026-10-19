import {expect, test} from '@playwright/test';
import {captureState, setupRegistrationMocks} from './registrationMocks';

for(const mode of ['open', 'invite'] as const) {
  test(`registers a username account in ${mode} mode without a live server`, async({page}, testInfo) => {
    const turnstileRequests: string[] = [];
    page.on('request', (request) => {
      if(request.url().includes('challenges.cloudflare.com')) turnstileRequests.push(request.url());
    });
    const username = mode === 'open' ? 'test_user_open' : 'test_user_invite';
    const inviteSecret = 'test-invite-secret';
    const password = 'Teagram-Test-Password-123!';

    await setupRegistrationMocks(page, testInfo, mode);

    await page.goto('/?noWorker=1', {waitUntil: 'domcontentloaded'});
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

    const calls = await page.evaluate(() => (window as any).__registrationCalls as Array<{
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
    expect(turnstileRequests).toHaveLength(0);
    await expect.poll(() => page.evaluate(() => (window as any).apiManagerProxy.getUser(4242))).toMatchObject({
      _: 'user',
      id: 4242,
      first_name: 'CI Registration'
    });
  });
}

test('retries username registration when the server requests Turnstile', async({page}, testInfo) => {
  const turnstileRequests: string[] = [];
  page.on('request', (request) => {
    if(request.url().includes('challenges.cloudflare.com')) turnstileRequests.push(request.url());
  });
  await page.setViewportSize({width: 320, height: 720});
  await setupRegistrationMocks(page, testInfo, 'open', true, true);

  await page.goto('/?noWorker=1', {waitUntil: 'domcontentloaded'});
  const registration = page.locator('#auth-pages');
  await expect(registration.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await registration.getByRole('button', {name: 'Create account'}).click();
  await registration.locator('input[aria-label="Username"]').fill('test_user_open');
  await registration.locator('input[aria-label="Display name"]').fill('CI Registration');
  await registration.locator('input[aria-label="Password"]').fill('Teagram-Test-Password-123!');
  await registration.locator('input[aria-label="Confirm password"]').fill('Teagram-Test-Password-123!');
  await captureState(page, testInfo, 'turnstile-registration-form');
  await registration.getByRole('button', {name: 'Create account'}).click();

  const challenge = registration.getByTestId('turnstile-challenge');
  await expect(challenge).toBeVisible();
  await expect(challenge).toHaveAttribute('data-sitekey', 'test-site-key');
  await expect(challenge.getByRole('alert')).toHaveText("The security check couldn't load. Try again.");
  await captureState(page, testInfo, 'turnstile-unavailable');
  await expect.poll(() => turnstileRequests).toHaveLength(1);
  await registration.getByRole('button', {name: 'Try again'}).click();
  await expect(challenge.getByRole('status')).toHaveText('Loading security check…');
  await captureState(page, testInfo, 'turnstile-loading');
  await expect(registration.getByRole('button', {name: 'Complete security check'})).toBeVisible();
  await expect(registration.locator('input[aria-label="Display name"]')).toHaveValue('CI Registration');
  await expect.poll(() => turnstileRequests).toHaveLength(2);
  await captureState(page, testInfo, 'turnstile-ready');
  const challengeWidths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  expect(challengeWidths.document).toBeLessThanOrEqual(challengeWidths.viewport);
  await page.setViewportSize({width: 768, height: 900});
  const wideChallengeWidths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  expect(wideChallengeWidths.document).toBeLessThanOrEqual(wideChallengeWidths.viewport);
  await page.setViewportSize({width: 320, height: 720});
  const narrowChallengeWidths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  expect(narrowChallengeWidths.document).toBeLessThanOrEqual(narrowChallengeWidths.viewport);

  await registration.getByRole('button', {name: 'Expire security check'}).click();
  await expect(registration.getByRole('alert')).toHaveText('The security check expired. Try again.');
  await captureState(page, testInfo, 'turnstile-expired');
  await expect(registration.locator('input[aria-label="Display name"]')).toHaveValue('CI Registration');
  await registration.getByRole('button', {name: 'Try again'}).focus();
  await page.keyboard.press('Enter');
  await registration.getByRole('button', {name: 'Complete security check'}).click();
  await expect(challenge.getByRole('status')).toHaveText('Checking…');
  await captureState(page, testInfo, 'turnstile-checking');
  await expect(registration.getByRole('alert')).toHaveText('The security check failed. Try again.');
  await captureState(page, testInfo, 'turnstile-rejected');
  await registration.getByRole('button', {name: 'Try again'}).click();
  await registration.getByRole('button', {name: 'Complete security check'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'turnstile-signup-complete');

  const calls = await page.evaluate(() => (window as any).__registrationCalls as Array<{
    method: string,
    params?: Record<string, any>
  }>);
  const wrappedCalls = calls.filter((call) => call.method === 'invokeWithReCaptcha');
  expect(wrappedCalls).toHaveLength(2);
  expect(wrappedCalls[0].params).toMatchObject({
    token: 'rejected-turnstile-token',
    query: {
      _: 'auth.signUp',
      phone_number: 'test_user_open',
      first_name: 'CI Registration',
      last_name: ''
    }
  });
  expect(wrappedCalls[1].params).toMatchObject({
    token: 'synthetic-turnstile-token',
    query: {_: 'auth.signUp', phone_number: 'test_user_open', first_name: 'CI Registration'}
  });
  expect(turnstileRequests).toHaveLength(2);
});
