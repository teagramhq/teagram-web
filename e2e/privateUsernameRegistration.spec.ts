import {expect, test} from '@playwright/test';
import {captureState, setupRegistrationMocks, TEST_TURNSTILE_SITE_KEY} from './registrationMocks';

for(const mode of ['open', 'invite'] as const) {
  test(`registers a username account in ${mode} mode without a live server`, async({page}, testInfo) => {
    const turnstileRequests: string[] = [];
    page.on('request', (request) => {
      if(request.url().includes('challenges.cloudflare.com')) turnstileRequests.push(request.url());
    });
    const username = mode === 'open' ? 'ab' : 'test_user_invite';
    const inviteSecret = 'test-invite-secret';
    const password = 'Teagram-Test-Password-123!';

    await setupRegistrationMocks(page, testInfo, mode);

    await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
    const registration = page.locator('#auth-pages');
    await expect(registration.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
    await expect(registration.getByRole('button', {name: 'Create account'})).toBeVisible({timeout: 30_000});
    await registration.getByRole('button', {name: 'Create account'}).click();

    const usernameInput = registration.locator('input[aria-label="Username"]');
    await usernameInput.fill(mode === 'open' ? 'a' : username);
    await registration.locator('input[aria-label="Display name"]').fill('CI Registration');
    await registration.locator('input[aria-label="Password"]').fill(password);
    await registration.locator('input[aria-label="Confirm password"]').fill(password);
    if(mode === 'invite') {
      await registration.locator('input[aria-label="Invite secret"]').fill(inviteSecret);
    } else {
      await expect(registration.locator('input[aria-label="Invite secret"]')).toHaveCount(0);
    }

    const createAccount = registration.getByRole('button', {name: 'Create account'});
    if(mode === 'open') {
      await expect(createAccount).toBeDisabled();
      await captureState(page, testInfo, 'registration-server-username-too-short');
      await usernameInput.fill(username);
      await expect(createAccount).toBeEnabled();
      await captureState(page, testInfo, 'registration-short-server-username');
    }
    await createAccount.click();
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

test('applies the configured display-name maximum during registration', async({page}, testInfo) => {
  await setupRegistrationMocks(page, testInfo, 'open', false, false, false, false, undefined, {
    displayNameMaxLength: 4
  });

  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const registration = page.locator('#auth-pages');
  await expect(registration.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await registration.getByRole('button', {name: 'Create account'}).click();
  await registration.locator('input[aria-label="Username"]').fill('ab');
  const displayName = registration.locator('input[aria-label="Display name"]');
  await displayName.fill('12345');
  await registration.locator('input[aria-label="Password"]').fill('Teagram-Test-Password-123!');
  await registration.locator('input[aria-label="Confirm password"]').fill('Teagram-Test-Password-123!');
  const createAccount = registration.getByRole('button', {name: 'Create account'});

  await expect(displayName).toHaveClass(/error/);
  await expect(createAccount).toBeDisabled();
  await captureState(page, testInfo, 'registration-display-name-over-limit');

  await displayName.fill('1234');
  await expect(createAccount).toBeEnabled();
  await captureState(page, testInfo, 'registration-display-name-at-limit');
});

test('shows the server username error when appConfig omits username rules', async({page}, testInfo) => {
  await setupRegistrationMocks(page, testInfo, 'open', false, false, false, false, undefined, {
    includeUsernamePolicy: false,
    signUpError: 'USERNAME_INVALID'
  });

  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const registration = page.locator('#auth-pages');
  await expect(registration.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await registration.getByRole('button', {name: 'Create account'}).click();
  await registration.locator('input[aria-label="Username"]').fill('a');
  await registration.locator('input[aria-label="Display name"]').fill('CI Registration');
  await registration.locator('input[aria-label="Password"]').fill('Teagram-Test-Password-123!');
  await registration.locator('input[aria-label="Confirm password"]').fill('Teagram-Test-Password-123!');
  await expect(registration.getByRole('button', {name: 'Create account'})).toBeEnabled();
  await registration.getByRole('button', {name: 'Create account'}).click();

  const username = registration.getByRole('textbox', {name: 'Username'});
  await expect(registration.getByRole('alert')).toHaveText('Choose a valid username.');
  await expect(username).toHaveAttribute('aria-invalid', 'true');
  await expect(username).toHaveValue('a');
  await captureState(page, testInfo, 'registration-server-username-error');
});

test('shows username and password feedback in the registration form', async({page}, testInfo) => {
  await page.setViewportSize({width: 320, height: 720});
  await setupRegistrationMocks(page, testInfo, 'open', false, false, false, false, undefined, {
    takenUsername: 'adam',
    delayAuthResponse: true,
    reservedUsername: 'admin'
  });
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});

  const registration = page.locator('#auth-pages');
  await expect(registration.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await registration.getByRole('button', {name: 'Create account'}).click();

  const username = registration.getByRole('textbox', {name: 'Username'});
  const displayName = registration.getByRole('textbox', {name: 'Display name'});
  const password = registration.getByRole('textbox', {name: 'Password', exact: true});
  const confirmPassword = registration.getByRole('textbox', {name: 'Confirm password'});
  const create = registration.getByRole('button').filter({hasText: /Create account|Please wait…/});

  await username.focus();
  await page.keyboard.press('Tab');
  await expect(displayName).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(password).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirmPassword).toBeFocused();

  await expect(registration.locator('#registration-username-status')).toHaveText('');
  await expect(create).toBeDisabled();
  await username.fill('a');
  await expect(registration.locator('#registration-username-status')).toHaveText('Choose a valid username.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await captureState(page, testInfo, 'registration-username-too-short');

  await username.fill('adam');
  await expect(registration.locator('#registration-username-status')).toHaveText('');
  await expect(username).not.toHaveAttribute('aria-invalid', 'true');

  await username.fill('adam-name');
  await expect(registration.locator('#registration-username-status')).toHaveText('Choose a valid username.');
  await captureState(page, testInfo, 'registration-username-invalid-character');

  await username.fill('admin');
  await displayName.fill('CI Registration');
  await password.fill('x');
  await expect(registration.locator('#registration-password-status')).toHaveCount(0);
  await expect(registration.locator('#registration-password-rules')).toHaveCount(0);
  await expect(registration.locator('#registration-confirm-password-status')).toHaveText('Enter your password again.');

  await confirmPassword.fill('y');
  await expect(registration.locator('#registration-confirm-password-status')).toHaveText('Those passwords don\'t match.');
  await expect(create).toBeDisabled();
  await captureState(page, testInfo, 'registration-password-mismatch');

  await confirmPassword.fill('x');
  await expect(registration.locator('#registration-confirm-password-status')).toHaveText('Passwords match.');
  await expect(create).toBeEnabled();
  await captureState(page, testInfo, 'registration-password-match');
  await confirmPassword.focus();
  await page.keyboard.press('Tab');
  await expect(create).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(create).toHaveText('Please wait…');
  await captureState(page, testInfo, 'registration-submitting');
  await expect(registration.locator('#registration-username-status')).toHaveText('Choose a valid username.', {timeout: 30_000});
  await expect(username).toHaveAttribute('aria-invalid', 'true');
  await captureState(page, testInfo, 'registration-username-reserved');

  await username.fill('adam');
  await expect(registration.locator('#registration-username-status')).toHaveText('');
  await create.click();
  await expect(registration.locator('#registration-username-status')).toHaveText('That username is taken.', {timeout: 30_000});
  await expect(username).toHaveAttribute('aria-invalid', 'true');
  await captureState(page, testInfo, 'registration-username-taken');

  const calls = await page.evaluate(() => (window as any).__registrationCalls as Array<{method: string}>);
  expect(calls.filter((call) => call.method.startsWith('auth.')).map((call) => call.method)).toEqual([
    'auth.sendCode', 'auth.signIn', 'auth.signUp',
    'auth.sendCode', 'auth.signIn', 'auth.signUp'
  ]);
});

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
  await expect(challenge).toHaveAttribute('data-sitekey', TEST_TURNSTILE_SITE_KEY);
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

test('requires instance terms before account creation and preserves the form when declined', async({page}, testInfo) => {
  const termsText = [
    'These are the terms for this server.',
    'Read each section before you create your account.',
    'Visit https://terms.example.test for the full terms.',
    ...Array.from({length: 32}, (_, index) => `Section ${index + 1}: This server terms line keeps the document long enough to scroll.`)
  ].join('\n');
  await page.setViewportSize({width: 320, height: 720});
  await setupRegistrationMocks(page, testInfo, 'open', false, false, false, false, termsText);

  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const registration = page.locator('#auth-pages');
  await expect(registration.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await registration.getByRole('button', {name: 'Create account'}).click();
  await registration.locator('input[aria-label="Username"]').fill('test_user_terms');
  await registration.locator('input[aria-label="Display name"]').fill('CI Terms');
  await registration.locator('input[aria-label="Password"]').fill('Teagram-Test-Password-123!');
  await registration.locator('input[aria-label="Confirm password"]').fill('Teagram-Test-Password-123!');
  await registration.locator('input[aria-label="Confirm password"]').press('Enter');

  const dialog = page.getByRole('dialog', {name: 'Terms of service'});
  const declinedTermsNotice = registration.getByRole('status').filter({hasText: 'No account was created.'});
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('These are the terms for this server.');
  const termsLink = dialog.getByRole('link', {name: 'https://terms.example.test'});
  await expect(termsLink).toHaveAttribute('target', '_blank');
  await expect(termsLink).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(dialog.getByRole('button', {name: 'Decline'})).toBeVisible();
  await expect(dialog.getByRole('button', {name: 'Accept'})).toBeVisible();
  const canScroll = await page.locator('.popup-peer .scrollable-y-bordered').evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(canScroll).toBe(true);
  const callsBeforeDecline = await page.evaluate(() => (window as any).__registrationCalls as Array<{method: string}>);
  expect(callsBeforeDecline.filter((call) => call.method === 'auth.signUp')).toHaveLength(0);
  await captureState(page, testInfo, 'registration-terms-default');

  await dialog.getByRole('button', {name: 'Decline'}).click();
  await expect(dialog).toBeHidden();
  await expect(declinedTermsNotice).toHaveText('No account was created. Accept the terms to create one.');
  await expect(registration.locator('input[aria-label="Username"]')).toHaveValue('test_user_terms');
  await expect(registration.locator('input[aria-label="Display name"]')).toHaveValue('CI Terms');
  await expect(registration.locator('input[aria-label="Password"]')).toHaveValue('Teagram-Test-Password-123!');
  await expect(registration.getByRole('button', {name: 'Create account'})).toBeFocused();
  await captureState(page, testInfo, 'registration-terms-declined');
  const callsAfterDecline = await page.evaluate(() => (window as any).__registrationCalls as Array<{method: string}>);
  expect(callsAfterDecline.filter((call) => call.method === 'auth.signUp')).toHaveLength(0);

  await registration.getByRole('button', {name: 'Create account'}).click();
  await expect(declinedTermsNotice).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await captureState(page, testInfo, 'registration-terms-reopened');
  await dialog.locator('.popup-description').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await captureState(page, testInfo, 'registration-terms-accepted');

  const acceptedCalls = await page.evaluate(() => (window as any).__registrationCalls as Array<{method: string}>);
  expect(acceptedCalls.filter((call) => call.method === 'auth.signUp')).toHaveLength(1);
});
