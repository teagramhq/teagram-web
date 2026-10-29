import {expect, test} from '@playwright/test';
import {setupRegistrationMocks} from './registrationMocks';

const screenshotSizes: Record<string, {width: number, height: number}> = {
  'invite-friends-settings-entry': {width: 360, height: 723},
  'invite-friends-settings-entry-night': {width: 360, height: 723},
  'invite-friends-empty-list': {width: 360, height: 467},
  'invite-friends-loading': {width: 360, height: 467},
  'invite-friends-creating': {width: 360, height: 738},
  'invite-friends-created-link': {width: 520, height: 721},
  'invite-friends-created-link-night': {width: 520, height: 721},
  'invite-friends-created-link-phone': {width: 360, height: 761},
  'invite-friends-link-shown-once': {width: 520, height: 721},
  'invite-friends-after-copy': {width: 520, height: 721},
  'invite-friends-share-ready': {width: 520, height: 721},
  'invite-friends-share-ready-night': {width: 520, height: 721},
  'invite-friends-share-ready-phone': {width: 360, height: 761},
  'invite-friends-pending-row': {width: 360, height: 738},
  'invite-friends-all-row-states': {width: 360, height: 738},
  'invite-friends-all-row-states-night': {width: 360, height: 738},
  'invite-friends-row-menu': {width: 360, height: 738},
  'invite-friends-close-before-copy': {width: 520, height: 361},
  'invite-friends-revoke-menu-action': {width: 360, height: 738},
  'invite-friends-revoke-confirmation': {width: 520, height: 361},
  'invite-friends-revoke-failed': {width: 360, height: 738},
  'invite-friends-weekly-limit': {width: 360, height: 738},
  'invite-friends-weekly-limit-night': {width: 360, height: 738},
  'invite-friends-open-registration': {width: 360, height: 738},
  'invite-friends-list-failed': {width: 360, height: 427},
  'invite-friends-list-retried': {width: 360, height: 467},
  'invite-friends-create-failed': {width: 360, height: 738},
  'invite-friends-account-too-new': {width: 360, height: 467},
  'invite-registration-signed-in-confirm': {width: 520, height: 421},
  'invite-registration-add-failed': {width: 800, height: 600},
  'invite-registration-storage-unavailable': {width: 800, height: 600},
  'invite-registration-account-switch-failed': {width: 800, height: 600},
  'invite-registration-prefilled': {width: 520, height: 1061},
  'invite-registration-prefilled-mobile': {width: 360, height: 761},
  'invite-registration-ready': {width: 520, height: 1061},
  'invite-registration-refused': {width: 520, height: 1061},
  'invite-registration-invalid-local': {width: 520, height: 1061}
};

async function captureInviteState(page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, name: string) {
  const size = screenshotSizes[name];
  if(size) {
    const current = page.viewportSize();
    if(current?.width !== size.width || current.height !== size.height) await page.setViewportSize(size);
  }
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({path, fullPage: false, animations: 'disabled', scale: 'css'});
  await testInfo.attach(name, {path, contentType: 'image/png'});
}

async function switchTheme(page: import('@playwright/test').Page, theme: 'day' | 'night') {
  await page.evaluate(async(name) => {
    // @ts-expect-error The Vite dev server resolves this browser-only module URL.
    const controller = (await import('/src/helpers/themeController.ts')).default;
    controller.applyTheme(controller.getTheme(name as 'day' | 'night'), document.documentElement);
    document.documentElement.classList.toggle('night', name === 'night');
  }, theme);
  await expect(page.locator('html')).toHaveClass(theme === 'night' ? /night/ : /^(?!.*night)/);
}

async function openInviteSettings(page: import('@playwright/test').Page) {
  await page.locator('.sidebar-tools-button').click();
  await page.getByText('Settings', {exact: true}).last().click();
  const inviteRow = page.getByText('Invite friends', {exact: true}).last();
  await expect(inviteRow).toBeVisible();
  await inviteRow.click({force: true});
  return inviteRow;
}

test('an existing user can retry an invite after a failure and blocked session storage', async({page}, testInfo) => {
  const baseURL = new URL(testInfo.project.use.baseURL as string);
  const inviteSecret = 'c'.repeat(64);
  const inviteURL = new URL('/invite', baseURL);
  inviteURL.hash = inviteSecret;

  await page.setViewportSize({width: 520, height: 720});
  await setupRegistrationMocks(page, testInfo, 'invite', false, false, false, false, undefined, {
    userInvitesEnabled: true,
    signInAsExistingUser: true,
    inviteLink: inviteURL.toString(),
    failSignedInInviteLookup: true
  });
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    (window as any).__failAccountSwitchForTest = false;
    Storage.prototype.setItem = function(key, value) {
      if(key === 'teagram-invite-secret' && new URL(location.href).searchParams.has('block-invite-storage')) {
        throw new DOMException('Storage unavailable', 'SecurityError');
      }
      if(key.endsWith('previous-account') && (window as any).__failAccountSwitchForTest) {
        throw new DOMException('Account switch failed', 'SecurityError');
      }
      setItem.call(this, key, value);
    };
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});

  const signInA = page.locator('#auth-pages');
  await signInA.getByRole('textbox', {name: 'Username'}).fill('invite_owner');
  await signInA.getByRole('button', {name: 'Next'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});

  await page.locator('.sidebar-tools-button').click();
  const settingsMenuItem = page.getByText('Settings', {exact: true}).last();
  await expect(settingsMenuItem).toBeVisible();
  await settingsMenuItem.click();
  const inviteRow = page.getByText('Invite friends', {exact: true}).last();
  await expect(inviteRow).toBeVisible();
  await inviteRow.scrollIntoViewIfNeeded();
  await inviteRow.evaluate((element) => {
    const scrollable = element.closest('.scrollable') as HTMLElement | null;
    if(scrollable) scrollable.scrollTop = Math.max(0, scrollable.scrollTop - 110);
  });
  await captureInviteState(page, testInfo, 'invite-friends-settings-entry');
  await switchTheme(page, 'night');
  await captureInviteState(page, testInfo, 'invite-friends-settings-entry-night');
  await switchTheme(page, 'day');
  await inviteRow.click({force: true});

  await expect(page.getByText('Invites you create will appear here.')).toBeVisible({timeout: 30_000});
  await captureInviteState(page, testInfo, 'invite-friends-empty-list');
  await page.getByRole('button', {name: 'Create invite link'}).click();
  await expect(page.getByText('Invite link created', {exact: true})).toBeVisible();
  await expect(page.getByText('Teagram can\'t show this link again.')).toBeVisible();
  const createdDialog = page.getByRole('dialog', {name: 'Invite link created'});
  await expect(createdDialog).toHaveAttribute('aria-modal', 'true');
  const createdDialogTitle = await createdDialog.getAttribute('aria-labelledby');
  expect(createdDialogTitle).toBeTruthy();
  await expect(page.locator(`#${createdDialogTitle}`)).toHaveText('Invite link created');
  const createdDialogClose = createdDialog.locator('.popup-close');
  await expect(createdDialogClose).toHaveAttribute('aria-label', 'Close');
  const copyButton = createdDialog.getByRole('button', {name: 'Copy link'});
  await expect(copyButton).toBeFocused();
  const firstDialogButton = createdDialog.locator('button').first();
  const lastDialogButton = createdDialog.locator('button').last();
  await lastDialogButton.focus();
  await page.keyboard.press('Tab');
  await expect(firstDialogButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lastDialogButton).toBeFocused();
  await captureInviteState(page, testInfo, 'invite-friends-created-link');
  await switchTheme(page, 'night');
  await captureInviteState(page, testInfo, 'invite-friends-created-link-night');
  await switchTheme(page, 'day');
  await page.setViewportSize({width: 360, height: 761});
  await captureInviteState(page, testInfo, 'invite-friends-created-link-phone');
  await page.setViewportSize({width: 520, height: 721});

  const createdLink = await page.evaluate(() => (window as any).__inviteLinkForTest as string);
  expect(createdLink).toBe(inviteURL.toString());
  await page.getByRole('button', {name: 'Copy link'}).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(createdLink);
  await captureInviteState(page, testInfo, 'invite-friends-copied-link');
  await expect(page.getByText('Link copied to clipboard', {exact: true})).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Your invites', {exact: true})).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-with-pending-link');

  await page.setViewportSize({width: 800, height: 600});
  const failedInviteURL = new URL(createdLink);
  failedInviteURL.searchParams.set('fail-invite-lookup', '1');
  await page.goto(failedInviteURL.toString(), {waitUntil: 'domcontentloaded'});
  await expect(page.getByText('An error occurred. Please try again later.', {exact: true})).toBeVisible({timeout: 30_000});
  await expect(page.locator('#page-chats')).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-registration-add-failed');

  const blockedStorageURL = new URL(createdLink);
  blockedStorageURL.searchParams.set('block-invite-storage', '1');
  await page.goto(blockedStorageURL.toString(), {waitUntil: 'domcontentloaded'});
  await expect(page.getByText('This invite link creates a new account on', {exact: false})).toBeVisible({timeout: 30_000});
  await expect(page).toHaveURL(/\/invite(?:\?|$)/);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  await captureInviteState(page, testInfo, 'invite-registration-signed-in-confirm');
  await page.getByRole('button', {name: 'Add account'}).click();
  await expect(page.getByText('An error occurred. Please try again later.', {exact: true})).toBeVisible({timeout: 30_000});
  await expect(page.locator('#page-chats')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#${inviteSecret}`);
  await captureInviteState(page, testInfo, 'invite-registration-storage-unavailable');

  const retryURL = await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.delete('block-invite-storage');
    return url.toString();
  });
  await page.goto(retryURL, {waitUntil: 'domcontentloaded'});
  await expect(page.getByText('This invite link creates a new account on', {exact: false})).toBeVisible({timeout: 30_000});
  await page.evaluate(() => (window as any).__failAccountSwitchForTest = true);
  await page.getByRole('button', {name: 'Add account'}).click();
  await expect(page.getByText('An error occurred. Please try again later.', {exact: true})).toBeVisible({timeout: 30_000});
  await expect(page.locator('#page-chats')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#${inviteSecret}`);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('teagram-invite-secret'))).toBe(inviteSecret);
  await captureInviteState(page, testInfo, 'invite-registration-account-switch-failed');

  await page.reload({waitUntil: 'domcontentloaded'});
  await expect(page.getByText('This invite link creates a new account on', {exact: false})).toBeVisible({timeout: 30_000});
  await page.getByRole('button', {name: 'Add account'}).click();

  const registration = page.locator('#auth-pages');
  await expect(registration.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await expect(page).toHaveURL(/account=2/);
  await expect(registration.locator('input[aria-label="Invite link or code"]')).toHaveValue(inviteSecret);
  await expect(registration.locator('input[aria-label="Username"]')).toBeFocused();
  await expect(registration.locator('#registration-invite-secret-status')).toHaveText('Filled in from your invite link.');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('teagram-invite-secret'))).toBeNull();
  await captureInviteState(page, testInfo, 'invite-registration-prefilled');

  await page.setViewportSize({width: 360, height: 760});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await captureInviteState(page, testInfo, 'invite-registration-prefilled-mobile');
  await page.setViewportSize({width: 800, height: 600});
  await registration.locator('input[aria-label="Username"]').fill('new_invite_user');
  await registration.locator('input[aria-label="Display name"]').fill('New Invite User');
  await registration.locator('input[aria-label="Password"]').fill('Teagram-Test-Password-123!');
  await registration.locator('input[aria-label="Confirm password"]').fill('Teagram-Test-Password-123!');
  await expect(registration.getByRole('button', {name: 'Create account'})).toBeEnabled();
  await captureInviteState(page, testInfo, 'invite-registration-ready');
  await registration.getByRole('button', {name: 'Create account'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await captureInviteState(page, testInfo, 'invite-registration-complete');

  const calls = await page.evaluate(() => (window as any).__registrationCalls as Array<{
    method: string,
    params?: Record<string, unknown>
  }>);
  expect(calls.filter((call) => call.method.startsWith('auth.')).map((call) => call.method)).toEqual([
    'auth.sendCode', 'auth.signIn', 'auth.signUp'
  ]);
  expect(calls.find((call) => call.method === 'auth.signIn')?.params?.phone_code).toBe(inviteSecret);
  expect(JSON.stringify(calls.find((call) => call.method === 'auth.signUp')?.params)).not.toContain(inviteSecret);
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(await page.evaluate(() => new URL(location.href).searchParams.get('invite'))).toBeNull();
  expect(await page.evaluate(() => [localStorage, sessionStorage].map((storage) =>
    Array.from({length: storage.length}, (_, index) => storage.getItem(storage.key(index) || '')).join('\n')
  ).join('\n'))).not.toContain(inviteSecret);
});

test('a refused invite keeps the registration details and shows the shared error', async({page}, testInfo) => {
  const baseURL = new URL(testInfo.project.use.baseURL as string);
  const inviteSecret = 'd'.repeat(64);
  const inviteURL = new URL('/invite', baseURL);
  inviteURL.hash = inviteSecret;

  await page.setViewportSize({width: 800, height: 600});
  await setupRegistrationMocks(page, testInfo, 'invite', false, false, false, false, undefined, {
    signUpError: 'INVITE_HASH_INVALID'
  });
  await page.goto(inviteURL.toString(), {waitUntil: 'domcontentloaded'});

  const registration = page.locator('#auth-pages');
  await expect(registration.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await registration.locator('input[aria-label="Username"]').fill('refused_invite_user');
  await registration.locator('input[aria-label="Display name"]').fill('Refused Invite User');
  await registration.locator('input[aria-label="Password"]').fill('Teagram-Test-Password-123!');
  await registration.locator('input[aria-label="Confirm password"]').fill('Teagram-Test-Password-123!');
  await registration.getByRole('button', {name: 'Create account'}).click();

  const inviteField = registration.locator('input[aria-label="Invite link or code"]');
  await expect(inviteField).toBeFocused();
  await expect(inviteField).toHaveAttribute('aria-invalid', 'true');
  await expect(registration.locator('#registration-invite-secret-status')).toHaveText('This invite can\'t be used. Ask whoever invited you for a new one.');
  await expect(registration.locator('input[aria-label="Username"]')).toHaveValue('refused_invite_user');
  await captureInviteState(page, testInfo, 'invite-registration-refused');
});

test('a malformed invite is rejected locally without sending it to the server', async({page}, testInfo) => {
  await page.setViewportSize({width: 520, height: 1061});
  await setupRegistrationMocks(page, testInfo, 'invite');
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const signIn = page.locator('#auth-pages');
  await expect(signIn.getByRole('textbox', {name: 'Username'})).toBeVisible({timeout: 30_000});
  await signIn.getByRole('button', {name: 'Create account'}).click();

  const registration = page.locator('#auth-pages');
  const inviteField = registration.locator('input[aria-label="Invite link or code"]');
  await registration.locator('input[aria-label="Username"]').fill('malformed_invite_user');
  await registration.locator('input[aria-label="Display name"]').fill('Malformed Invite User');
  await registration.locator('input[aria-label="Password"]').fill('Teagram-Test-Password-123!');
  await registration.locator('input[aria-label="Confirm password"]').fill('Teagram-Test-Password-123!');
  await inviteField.fill('not-a-complete-invite');
  await registration.getByRole('button', {name: 'Create account'}).click();

  await expect(inviteField).toBeFocused();
  await expect(inviteField).toHaveAttribute('aria-invalid', 'true');
  await expect(registration.locator('#registration-invite-secret-status')).toHaveText('That\'s not a complete invite link or code. Copy the whole link and paste it again.');
  await captureInviteState(page, testInfo, 'invite-registration-invalid-local');
  const calls = await page.evaluate(() => (window as any).__registrationCalls as Array<{method: string}>);
  expect(calls.some((call) => call.method === 'auth.signUp')).toBe(false);
  expect(calls.some((call) => call.method === 'auth.sendCode')).toBe(false);
});

test('share sends the invite through the browser share sheet and skips the close guard', async({page}, testInfo) => {
  const baseURL = new URL(testInfo.project.use.baseURL as string);
  const inviteURL = new URL('/invite', baseURL);
  inviteURL.hash = 'f'.repeat(64);

  await setupRegistrationMocks(page, testInfo, 'invite', false, false, false, false, undefined, {
    userInvitesEnabled: true,
    signInAsExistingUser: true,
    inviteLink: inviteURL.toString()
  });
  await page.addInitScript(() => {
    const calls: ShareData[] = (window as any).__inviteShareCalls = [];
    Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
    Object.defineProperty(navigator, 'share', {configurable: true, value: async(data: ShareData) => { calls.push(data); }});
  });
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const signIn = page.locator('#auth-pages');
  await signIn.getByRole('textbox', {name: 'Username'}).fill('share_invite_owner');
  await signIn.getByRole('button', {name: 'Next'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await openInviteSettings(page);
  await page.getByRole('button', {name: 'Create invite link'}).click();
  await expect(page.getByRole('button', {name: 'Share link'})).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-share-ready');
  await switchTheme(page, 'night');
  await captureInviteState(page, testInfo, 'invite-friends-share-ready-night');
  await switchTheme(page, 'day');
  await captureInviteState(page, testInfo, 'invite-friends-share-ready-phone');
  await page.setViewportSize({width: 520, height: 721});

  await page.getByRole('button', {name: 'Share link'}).click();
  await expect.poll(() => page.evaluate(() => ((window as any).__inviteShareCalls as ShareData[]).length)).toBe(1);
  const shared = await page.evaluate(() => (window as any).__inviteShareCalls[0] as ShareData);
  expect(shared.title).toBe('Teagram invite');
  expect(shared.url).toBe(inviteURL.toString());
  await page.keyboard.press('Escape');
  await expect(page.locator('.popup').filter({has: page.getByRole('button', {name: 'Copy link'})})).toHaveCount(0);
  await expect(page.getByText('Your invites', {exact: true})).toBeVisible();
});

test('invite settings handles loading, quota, keyboard revoke, and failures', async({page}, testInfo) => {
  const baseURL = new URL(testInfo.project.use.baseURL as string);
  const inviteSecret = 'e'.repeat(64);
  const inviteURL = new URL('/invite', baseURL);
  inviteURL.hash = inviteSecret;

  await page.setViewportSize({width: 520, height: 720});
  await setupRegistrationMocks(page, testInfo, 'invite', false, false, false, false, undefined, {
    userInvitesEnabled: true,
    signInAsExistingUser: true,
    inviteLink: inviteURL.toString(),
    inviteListDelay: 1200
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const signIn = page.locator('#auth-pages');
  await signIn.getByRole('textbox', {name: 'Username'}).fill('invite_state_owner');
  await signIn.getByRole('button', {name: 'Next'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});

  await openInviteSettings(page);
  await expect(page.locator('[role="status"][aria-label="Please wait…"]')).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-loading');
  await expect(page.getByText('Invites you create will appear here.')).toBeVisible({timeout: 5000});
  await page.evaluate(() => ((window as any).__registrationMockOptions.inviteListDelay = 0));
  await captureInviteState(page, testInfo, 'invite-friends-empty-list');

  await page.evaluate(() => ((window as any).__registrationMockOptions.createInviteDelay = 1200));
  const createButton = page.getByRole('button', {name: 'Create invite link'});
  await createButton.focus();
  await page.keyboard.press('Enter');
  const creatingButton = page.getByRole('button', {name: 'Creating link…'});
  await expect(creatingButton).toBeDisabled();
  await captureInviteState(page, testInfo, 'invite-friends-creating');
  const copyButton = page.getByRole('button', {name: 'Copy link'});
  const createdPopup = page.locator('.popup').filter({has: copyButton});
  const closeConfirmation = page.locator('.popup-confirmation');
  await expect(copyButton).toBeVisible({timeout: 10_000});
  await expect(copyButton).toBeFocused();
  await captureInviteState(page, testInfo, 'invite-friends-link-shown-once');

  await copyButton.click();
  await expect(page.getByText('Link copied to clipboard', {exact: true})).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-after-copy');
  await expect(page.getByText('Link copied to clipboard', {exact: true})).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Your invites', {exact: true})).toBeVisible();
  await expect(createdPopup).toHaveCount(0);
  await captureInviteState(page, testInfo, 'invite-friends-pending-row');

  await page.evaluate(() => ((window as any).__registrationMockOptions.createInviteDelay = 0));
  await createButton.click();
  await expect(copyButton).toBeVisible({timeout: 10_000});
  await page.keyboard.press('Escape');
  await expect(page.getByText('You haven\'t copied or shared this link.', {exact: false})).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-close-before-copy');
  await page.getByRole('button', {name: 'Close', exact: true}).last().click();
  await expect(page.getByText('Your invites', {exact: true})).toBeVisible();
  await expect(closeConfirmation).toHaveCount(0);
  await expect(createdPopup).toHaveCount(0);

  await page.setViewportSize({width: 360, height: 738});
  const pendingRow = page.getByRole('button', {name: /Not used yet/}).first();
  await pendingRow.click({button: 'right'});
  const revokeMenuItem = page.getByText('Revoke link', {exact: true}).last();
  await expect(revokeMenuItem).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-row-menu');
  await revokeMenuItem.click();
  await captureInviteState(page, testInfo, 'invite-friends-revoke-menu-action');
  await expect(page.getByText('Nobody will be able to create an account with this link.', {exact: false})).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-revoke-confirmation');
  await page.getByRole('button', {name: 'Cancel'}).last().click();

  await page.evaluate(() => ((window as any).__registrationMockOptions.revokeInviteError = 'NETWORK'));
  await pendingRow.focus();
  await page.keyboard.press('Enter');
  await page.getByText('Revoke link', {exact: true}).last().click();
  await page.getByRole('button', {name: 'Revoke link'}).last().click();
  await expect(page.getByText('Couldn\'t revoke the link. Check your connection and try again.', {exact: true})).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-revoke-failed');
});

test('invite history shows every state without making old rows actionable', async({page}, testInfo) => {
  const now = Math.floor(Date.now() / 1000);
  await setupRegistrationMocks(page, testInfo, 'invite', false, false, false, false, undefined, {
    userInvitesEnabled: true,
    signInAsExistingUser: true,
    initialInvites: [
      {_: 'teagram.userInvite', id: '9101', state: 'pending', created_at: now - 3600, expires_at: now + 6 * 86_400},
      {_: 'teagram.userInvite', id: '9102', state: 'used', created_at: now - 86_400, expires_at: now + 6 * 86_400},
      {_: 'teagram.userInvite', id: '9103', state: 'expired', created_at: now - 8 * 86_400, expires_at: now - 86_400},
      {_: 'teagram.userInvite', id: '9104', state: 'revoked', created_at: now - 2 * 86_400, expires_at: now + 5 * 86_400}
    ],
    inviteQuota: 5,
    inviteWeeklyCount: 4
  });
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const signIn = page.locator('#auth-pages');
  await signIn.getByRole('textbox', {name: 'Username'}).fill('invite_history_owner');
  await signIn.getByRole('button', {name: 'Next'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await openInviteSettings(page);

  for(const state of ['Not used yet', 'Used', 'Expired', 'Revoked']) {
    await expect(page.getByText(state, {exact: true})).toBeVisible();
  }
  await expect(page.getByRole('button', {name: /Not used yet/})).toHaveCount(1);
  for(const state of ['Used', 'Expired', 'Revoked']) {
    await expect(page.getByRole('button', {name: new RegExp(state)})).toHaveCount(0);
  }
  await expect(page.getByText(/910[1-4]|[a-f]{64}/i)).toHaveCount(0);
  await captureInviteState(page, testInfo, 'invite-friends-all-row-states');
  await switchTheme(page, 'night');
  await captureInviteState(page, testInfo, 'invite-friends-all-row-states-night');
  await switchTheme(page, 'day');
});

test('invite settings enforces the weekly quota', async({page}, testInfo) => {
  await page.setViewportSize({width: 520, height: 720});
  await setupRegistrationMocks(page, testInfo, 'invite', false, false, false, false, undefined, {
    userInvitesEnabled: true,
    signInAsExistingUser: true,
    initialInvites: [{
      _: 'teagram.userInvite',
      id: '9002',
      state: 'pending',
      created_at: Math.floor(Date.now() / 1000) - 86_400,
      expires_at: Math.floor(Date.now() / 1000) + 6 * 86_400
    }],
    inviteQuota: 5,
    inviteWeeklyCount: 5,
    inviteNextAvailableAt: Math.floor(Date.now() / 1000) + 86_400
  });
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const signIn = page.locator('#auth-pages');
  await signIn.getByRole('textbox', {name: 'Username'}).fill('invite_quota_owner');
  await signIn.getByRole('button', {name: 'Next'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await openInviteSettings(page);

  await expect(page.getByText('You\'ve used all 5 invites for this week.', {exact: false})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Create invite link'})).toBeDisabled();
  await captureInviteState(page, testInfo, 'invite-friends-weekly-limit');
  await switchTheme(page, 'night');
  await captureInviteState(page, testInfo, 'invite-friends-weekly-limit-night');
  await switchTheme(page, 'day');
});

test('open registration disables invite creation and hides pending expiry', async({page}, testInfo) => {
  const now = Math.floor(Date.now() / 1000);
  await setupRegistrationMocks(page, testInfo, 'invite', false, false, false, false, undefined, {
    userInvitesEnabled: true,
    signInAsExistingUser: true,
    registrationMode: 'open',
    initialInvites: [{
      _: 'teagram.userInvite',
      id: '9201',
      state: 'pending',
      created_at: now - 3600,
      expires_at: now + 6 * 86_400
    }]
  });
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const signIn = page.locator('#auth-pages');
  await signIn.getByRole('textbox', {name: 'Username'}).fill('open_invites_owner');
  await signIn.getByRole('button', {name: 'Next'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await openInviteSettings(page);

  await expect(page.getByText('Anyone can create an account on this server now, so invites aren\'t needed.', {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Create invite link'})).toBeDisabled();
  const pendingRow = page.getByRole('button', {name: /Not used yet/});
  await expect(pendingRow).toBeVisible();
  await expect(pendingRow).not.toContainText('left');
  await captureInviteState(page, testInfo, 'invite-friends-open-registration');
});

test('invite settings retries loading and explains create errors', async({page}, testInfo) => {
  await page.setViewportSize({width: 520, height: 720});
  await setupRegistrationMocks(page, testInfo, 'invite', false, false, false, false, undefined, {
    userInvitesEnabled: true,
    signInAsExistingUser: true,
    inviteListDelay: 0,
    listInvitesError: 'NETWORK',
    createInviteError: 'NETWORK'
  });
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const signIn = page.locator('#auth-pages');
  await signIn.getByRole('textbox', {name: 'Username'}).fill('invite_errors_owner');
  await signIn.getByRole('button', {name: 'Next'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});
  await openInviteSettings(page);
  await expect(page.getByText('Couldn\'t load your invites.', {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Try again'})).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-list-failed');

  await page.evaluate(() => {
    (window as any).__registrationMockOptions.listInvitesError = undefined;
  });
  await page.getByRole('button', {name: 'Try again'}).click();
  await expect(page.getByText('Invites you create will appear here.')).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-list-retried');

  await page.getByRole('button', {name: 'Create invite link'}).click();
  await expect(page.getByRole('alert')).toContainText('Couldn\'t create the link. Check your connection and try again.');
  await captureInviteState(page, testInfo, 'invite-friends-create-failed');

  await page.evaluate(() => ((window as any).__registrationMockOptions.createInviteError = 'USER_INVITE_ACCOUNT_TOO_NEW_WAIT_86400'));
  await page.getByRole('button', {name: 'Create invite link'}).click();
  await expect(page.getByText('New accounts can\'t create invites right away.', {exact: false})).toBeVisible();
  await captureInviteState(page, testInfo, 'invite-friends-account-too-new');
});

test('settings hides invite management when the server has not enabled invites', async({page}, testInfo) => {
  await setupRegistrationMocks(page, testInfo, 'invite', false, false, false, false, undefined, {
    signInAsExistingUser: true
  });
  await page.goto('/?noWorker=1&noServiceWorker=1', {waitUntil: 'domcontentloaded'});
  const signIn = page.locator('#auth-pages');
  await signIn.getByRole('textbox', {name: 'Username'}).fill('no_invites_owner');
  await signIn.getByRole('button', {name: 'Next'}).click();
  await expect(page.locator('#page-chats')).toBeVisible({timeout: 30_000});

  await page.locator('.sidebar-tools-button').click();
  await page.getByText('Settings', {exact: true}).last().click();
  await expect(page.getByText('Invite friends', {exact: true})).toHaveCount(0);
});
