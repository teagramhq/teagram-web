import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, Page, test, type TestInfo} from '@playwright/test';
import {zipSync} from 'fflate';

/*
 * Opens every popup the sandbox knows about and asserts it actually renders.
 *
 * The sandbox (`src/components/popupSandbox`, entered with `?popups=1`) answers every manager call
 * from local fixtures, so this needs no session, no authorization and no Telegram traffic — a plain
 * dev server is enough. That makes it a cheap regression net over every popup in the app: one that
 * starts throwing on construction, or never reaches its visible state, fails here.
 *
 * This covers the FIXTURE source only. The panel's other source — the signed-in session's own data,
 * run against the real managers — needs an authorized preview and has no e2e yet; its write guard is
 * covered by `src/tests/popupSandboxLiveManagers.test.ts` instead.
 */

type Story = {id: string, title: string, group: string};

declare global {
  interface Window {
    popupSandbox: {
      ready(): Promise<void>,
      list(): Story[],
      open(id: string): Promise<void>,
      closePopups(): void,
      unhandled(): Array<{manager: string, method: string}>,
      calls(): Array<{manager: string, method: string, args: unknown[]}>
    };
    /** Where `openStory` parks the outcome for the poller below to pick up. */
    popupSandboxOutcome: {error: string} | undefined;
  }
}

// A popup reveals itself a couple of frames after construction, and some wait on a lottie decode.
const SHOWN_TIMEOUT = 10_000;
// Generous: the slowest story builds its popup in well under a second.
const OPEN_TIMEOUT = 30_000;

/**
 * Opens one story and returns the message it threw with, or null.
 *
 * Deliberately not `page.evaluate(async ...)`. An async evaluate hands the returned promise to
 * Chromium's inspector, which holds it with a WEAK handle (`Runtime.callFunctionOn` with
 * `awaitPromise`). Opening a popup allocates enough for a GC to land inside that window, and the
 * handle is then collected before the resolution is reported: the protocol answers
 * `-32000 Promise was collected`, which Playwright rewrites into the thoroughly misleading
 * "Execution context was destroyed, most likely because of a navigation." Nothing navigates and
 * nothing hangs — the story opens and its promise resolves (a few ms BEFORE that error arrives);
 * only the trip back to the test is lost. It used to take out `transaction/history-stars-self`,
 * the heaviest open in the registry, on nearly every full run.
 *
 * So: start the work from a synchronous evaluate that parks the outcome on the page, then poll for
 * it with short synchronous evaluates that never leave a pending promise with the debugger.
 */
async function openStory(page: Page, id: string): Promise<string> {
  await page.evaluate((storyId) => {
    window.popupSandboxOutcome = undefined;
    window.popupSandbox.open(storyId).then(
      () => {window.popupSandboxOutcome = {error: null};},
      (err) => {window.popupSandboxOutcome = {error: (err as Error)?.message || String(err)};}
    );
  }, id);

  const deadline = Date.now() + OPEN_TIMEOUT;
  for(;;) {
    const outcome = await page.evaluate(() => window.popupSandboxOutcome);
    if(outcome) return outcome.error;
    if(Date.now() > deadline) return `did not settle within ${OPEN_TIMEOUT}ms`;
    await page.waitForTimeout(50);
  }
}

async function openSandboxStory(page: Page, id: string, hideSidebar = false) {
  await page.goto('/?popups=1');
  await page.waitForFunction(() => !!window.popupSandbox, null, {timeout: 30_000});
  await page.evaluate(() => window.popupSandbox.ready());
  if(hideSidebar) {
    await page.getByRole('button', {name: '◂ Hide'}).click();
    await expect(page.locator('[role="complementary"][aria-label="Popup sandbox"]')).toHaveAttribute('aria-hidden', 'true');
  }
  expect(await openStory(page, id)).toBeNull();
  return page.locator('.popup.active').last();
}

async function capturePopupScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({path});
  await testInfo.attach(name, {path, contentType: 'image/png'});
}

test('every popup story opens and becomes visible', async({page}) => {
  // One test walks the whole registry, so it needs far more than the config's per-test default.
  test.setTimeout(5 * 60_000);

  const pageErrors: string[] = [];
  const renderErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message || String(error)));
  // Our Solid fork reports render failures through console.error rather than window.onerror.
  page.on('console', (message) => {
    if(message.type() === 'error' && message.text().startsWith('solid error')) {
      renderErrors.push(message.text().split('\n')[0]);
    }
  });

  await page.goto('/?popups=1');
  await page.waitForFunction(() => !!window.popupSandbox, null, {timeout: 30_000});
  await page.evaluate(() => window.popupSandbox.ready());

  const stories = await page.evaluate(() => window.popupSandbox.list());
  expect(stories.length).toBeGreaterThan(0);

  const failed: string[] = [];
  for(const story of stories) {
    pageErrors.length = 0;
    renderErrors.length = 0;

    const opened = await openStory(page, story.id);

    if(opened) {
      failed.push(`${story.id}: threw while opening — ${opened}`);
    } else {
      try {
        await expect.poll(
          () => page.evaluate(() => document.querySelectorAll('.popup.active').length),
          {timeout: SHOWN_TIMEOUT}
        ).toBeGreaterThan(0);
      } catch{
        failed.push(`${story.id}: never became visible`);
      }

      if(pageErrors.length) {
        failed.push(`${story.id}: page error — ${pageErrors.join(' | ')}`);
      }
    }

    // Teardown is deliberately outside the assertion window (errors reset at the top of the loop):
    // several popups model "cancelled" as a rejected promise, and closing one from a script rather
    // than through the caller's own flow leaves that rejection unhandled — the sandbox's doing.
    await page.evaluate(() => window.popupSandbox.closePopups());
    // Longer than the 250ms hide timeout, after which a closed popup fires `closeAfterTimeout`.
    await page.waitForTimeout(400);
    if(renderErrors.length) {
      failed.push(`${story.id}: render error — ${renderErrors.join(' | ')}`);
    }
  }

  expect(failed, `\n${failed.join('\n')}\n`).toEqual([]);
});

test('opens and installs a sticker set from a direct share URL', async({page}) => {
  const unrootedSubresources: string[] = [];
  page.on('request', (request) => {
    if(request.isNavigationRequest()) return;
    const url = new URL(request.url());
    if(url.pathname.startsWith('/addstickers/')) unrootedSubresources.push(url.pathname);
  });

  await page.goto('/addstickers/sandbox_stickers?popups=1#stickerShareLink');
  await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/');
  await expect.poll(() => page.evaluate(() => `${location.search}${location.hash}`))
  .toBe('?popups=1#stickerShareLink');
  await page.waitForFunction(() => !!window.popupSandbox, null, {timeout: 30_000});
  await page.evaluate(() => window.popupSandbox.ready());

  const stickerPopup = page.locator('.popup-stickers');
  await expect(stickerPopup).toBeVisible();
  await expect(stickerPopup.getByText('Sandbox Stickers', {exact: true})).toBeVisible();

  await stickerPopup.getByRole('button', {name: /add/i}).click();
  await expect.poll(() => page.evaluate(() => window.popupSandbox.calls()
    .filter((call) => call.manager === 'appStickersManager' && call.method === 'toggleStickerSets')
    .map((call) => (call.args[0] as Array<{id: string}>).map((set) => set.id)))).toEqual([['8001']]);
  expect(unrootedSubresources).toEqual([]);
});

test('imports a folder pack and opens its shareable sticker set', async({page}, testInfo) => {
  await page.setViewportSize({width: 375, height: 812});

  // A webkitdirectory input only accepts a real directory path, so the folder is written to this test's output dir.
  const folder = testInfo.outputPath('pack');
  mkdirSync(folder, {recursive: true});
  writeFileSync(join(folder, 'cat.webp'), Buffer.from([1, 2, 3]));

  const importPopup = await openSandboxStory(page, 'stickerPackImport', true);
  await expect(importPopup.getByText('Import a sticker pack', {exact: true})).toBeVisible();
  const popupBounds = await importPopup.boundingBox();
  if(!popupBounds) throw new Error('Sticker import popup is not visible at mobile width');
  expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(375);
  await importPopup.locator('input[name="sticker-pack-title"]').fill('Imported Pack');
  await importPopup.locator('input[name="sticker-pack-short-name"]').fill('sandbox_imported');
  await expect(importPopup.getByText('Link is available', {exact: true})).toBeVisible();
  await importPopup.locator('input[webkitdirectory]').setInputFiles(folder);
  const importButton = importPopup.getByRole('button', {name: 'Import pack'});
  const createStickerSetCalls = () => page.evaluate(() => window.popupSandbox.calls()
    .filter((call) => call.manager === 'appStickersManager' && call.method === 'createStickerSet'));

  const stickersRadio = importPopup.getByRole('radio', {name: 'Stickers'});
  const emojiRadio = importPopup.getByRole('radio', {name: 'Custom emoji'});
  await expect(stickersRadio).toBeChecked();
  await expect(importPopup.locator('.radio-field-main')).toHaveCount(2);
  const selectedRadioMarker = await importPopup.locator('.radio-field-main').first().evaluate((element) => ({
    width: parseFloat(getComputedStyle(element, '::before').width),
    selection: getComputedStyle(element, '::after').transform
  }));
  expect(selectedRadioMarker.width).toBeGreaterThan(0);
  expect(selectedRadioMarker.selection).not.toBe('matrix(0, 0, 0, 0, 0, 0)');
  await emojiRadio.focus();
  await emojiRadio.press('Space');
  await expect(emojiRadio).toBeChecked();
  await stickersRadio.focus();
  await stickersRadio.press('Space');
  await expect(stickersRadio).toBeChecked();
  await expect(importPopup.locator('.checkbox-box')).toBeVisible();
  await expect(importPopup.getByLabel('I have the right to share this pack.')).not.toBeChecked();
  await expect(importButton).toBeDisabled();
  expect(await createStickerSetCalls()).toEqual([]);
  await capturePopupScreenshot(page, testInfo, 'sticker-import-consent-disabled');

  await importPopup.getByLabel('I have the right to share this pack.').check();
  await expect(importPopup.getByLabel('I have the right to share this pack.')).toBeChecked();
  await expect.poll(() => importPopup.locator('.checkbox-box-check use').evaluate((element) => getComputedStyle(element).visibility)).toBe('visible');
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect.poll(createStickerSetCalls).toHaveLength(1);

  const stickerPopup = page.locator('.popup-stickers.popup.active');
  await expect(stickerPopup.getByText('Imported Pack', {exact: true})).toBeVisible();
  await expect(stickerPopup.locator('input[aria-label="Sticker pack link"]')).toHaveValue(
    'https://teagram.test/addstickers/sandbox_imported'
  );
  await expect(stickerPopup.getByRole('button', {name: 'Copy Link'})).toBeVisible();
  await page.evaluate(() => window.popupSandbox.closePopups());
});

test('imports a valid ZIP through the worker and sends its bytes as a ZIP source', async({page}, testInfo) => {
  const zipPath = testInfo.outputPath('pack.zip');
  writeFileSync(zipPath, zipSync({'cat.webp': Uint8Array.from([5, 6, 7])}));

  const importPopup = await openSandboxStory(page, 'stickerPackImport');
  await importPopup.locator('input[name="sticker-pack-title"]').fill('Imported Pack');
  await importPopup.locator('input[name="sticker-pack-short-name"]').fill('sandbox_imported');
  await expect(importPopup.getByText('Link is available', {exact: true})).toBeVisible();
  await importPopup.locator('input[accept=".zip,application/zip"]').setInputFiles(zipPath);
  await expect(importPopup.getByText('1 files selected from ZIP archive', {exact: true})).toBeVisible();
  await capturePopupScreenshot(page, testInfo, 'sticker-import-zip-selected');
  await importPopup.getByLabel('I have the right to share this pack.').check();
  await importPopup.getByRole('button', {name: 'Import pack'}).click();

  const importCall = () => page.evaluate(async() => {
    const call = window.popupSandbox.calls().find((entry) => entry.manager === 'appStickersManager' && entry.method === 'createStickerSet');
    if(!call) return undefined;
    const options = call.args[0] as {files: File[], software: string};
    return {
      software: options.software,
      names: options.files.map((file) => file.name),
      bytes: await Promise.all(options.files.map(async(file) => Array.from(new Uint8Array(await file.arrayBuffer()))))
    };
  });
  await expect.poll(importCall).toEqual({software: 'zip', names: ['cat.webp'], bytes: [[5, 6, 7]]});
});

test('imports a Telegram sticker pack through the Bot API without sending its token to Teagram', async({page}) => {
  const token = `987654321:${'Z'.repeat(35)}`;
  const telegramRequests: string[] = [];
  await page.route('https://api.telegram.org/**', async(route) => {
    const url = new URL(route.request().url());
    telegramRequests.push(url.toString());
    if(url.pathname.endsWith('/getStickerSet')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          result: {
            name: 'SomePack',
            title: 'Telegram Cats',
            sticker_type: 'regular',
            stickers: [{
              file_id: 'telegram-file-id',
              file_unique_id: 'telegram-file-unique-id',
              type: 'regular',
              width: 512,
              height: 512,
              is_animated: false,
              is_video: false,
              emoji: '🐈',
              file_size: 3
            }]
          }
        })
      });
      return;
    }

    if(url.pathname.endsWith('/getFile')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ok: true, result: {file_id: 'telegram-file-id', file_unique_id: 'telegram-file-unique-id', file_size: 3, file_path: 'stickers/cat.webp'}})
      });
      return;
    }

    await route.fulfill({status: 200, contentType: 'image/webp', body: Buffer.from([5, 6, 7])});
  });

  const importPopup = await openSandboxStory(page, 'stickerPackImport');
  await importPopup.locator('input[name="telegram-pack-link"]').fill('https://t.me/addstickers/SomePack');
  await importPopup.locator('input[name="telegram-bot-token"]').fill(token);
  await importPopup.getByRole('button', {name: 'Download from Telegram'}).click();
  await expect(importPopup.getByText('Downloaded 1 of 1 files.', {exact: true})).toBeVisible();
  await expect(importPopup.locator('input[name="sticker-pack-title"]')).toHaveValue('Telegram Cats');
  await importPopup.locator('input[name="sticker-pack-short-name"]').fill('telegram_cats');
  await expect(importPopup.getByText('Link is available', {exact: true})).toBeVisible();
  await importPopup.getByLabel('I have the right to share this pack.').check();
  await importPopup.getByRole('button', {name: 'Import pack'}).click();

  const importedPack = () => page.evaluate(async() => {
    const call = window.popupSandbox.calls().find((entry) => entry.manager === 'appStickersManager' && entry.method === 'createStickerSet');
    if(!call) return undefined;
    const options = call.args[0] as {files: File[], software: string, emojis: string[]};
    return {
      software: options.software,
      emojis: options.emojis,
      names: options.files.map((file) => file.name),
      bytes: await Promise.all(options.files.map(async(file) => Array.from(new Uint8Array(await file.arrayBuffer()))))
    };
  });

  await expect.poll(importedPack).toEqual({
    software: 'https://t.me/addstickers/SomePack',
    emojis: ['🐈'],
    names: ['sticker-001.webp'],
    bytes: [[5, 6, 7]]
  });
  expect(telegramRequests.map((request) => new URL(request).origin)).toEqual([
    'https://api.telegram.org',
    'https://api.telegram.org',
    'https://api.telegram.org'
  ]);
  expect(JSON.stringify(await importedPack())).not.toContain(token);
});

test('shows a redacted Telegram Bot API error and does not upload a failed pack', async({page}) => {
  const token = `123456789:${'Y'.repeat(35)}`;
  const consoleMessages: string[] = [];
  page.on('console', (message) => consoleMessages.push(message.text()));
  await page.route('https://api.telegram.org/**', async(route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ok: false, description: `Unauthorized ${token}`})
    });
  });

  const importPopup = await openSandboxStory(page, 'stickerPackImport');
  await importPopup.locator('input[name="telegram-pack-link"]').fill('https://t.me/addstickers/MissingPack');
  await importPopup.locator('input[name="telegram-bot-token"]').fill(token);
  await importPopup.getByRole('button', {name: 'Download from Telegram'}).click();
  await expect(importPopup.getByRole('alert')).toContainText('Unauthorized [redacted]');

  expect(await page.evaluate(() => window.popupSandbox.calls()
    .filter((call) => call.manager === 'appStickersManager' && call.method === 'createStickerSet'))).toEqual([]);
  expect(consoleMessages.join('\n')).not.toContain(token);
});

test('does not show the import controls when sticker import is disabled', async({page}, testInfo) => {
  const importPopup = await openSandboxStory(page, 'stickerPackImportOff');

  await expect(importPopup.getByText('Sticker pack import is turned off on this server.', {exact: true})).toBeVisible();
  await expect(importPopup.getByRole('button', {name: 'Import pack'})).toBeDisabled();
  expect(await page.evaluate(() => window.popupSandbox.calls()
    .filter((call) => call.manager === 'appStickersManager' && call.method === 'createStickerSet'))).toEqual([]);
  await capturePopupScreenshot(page, testInfo, 'sticker-import-disabled-mode');
});

test('shows the import configuration failure instead of enabling the flow', async({page}, testInfo) => {
  const importPopup = await openSandboxStory(page, 'stickerPackImportConfigFailed');

  await expect(importPopup.getByText('Couldn’t check whether sticker pack import is available.', {exact: true})).toBeVisible();
  await expect(importPopup.getByRole('button', {name: 'Try again'})).toBeVisible();
  await expect(importPopup.getByRole('button', {name: 'Import pack'})).toBeDisabled();
  await capturePopupScreenshot(page, testInfo, 'sticker-import-config-error');
});

test('uses a sticker set short name error and only displays API error codes', async({page}, testInfo) => {
  const importPopup = await openSandboxStory(page, 'stickerPackImportErrors');
  const folder = testInfo.outputPath('api-error-pack');
  mkdirSync(folder, {recursive: true});
  writeFileSync(join(folder, 'cat.webp'), Buffer.from([1, 2, 3]));

  await importPopup.locator('input[name="sticker-pack-title"]').fill('Imported Pack');
  await importPopup.locator('input[name="sticker-pack-short-name"]').fill('taken_name');
  await expect(importPopup.getByText('This short name is already taken.', {exact: true})).toBeVisible();
  await importPopup.locator('input[name="sticker-pack-short-name"]').fill('sandbox_imported');
  await expect(importPopup.getByText('Link is available', {exact: true})).toBeVisible();
  await importPopup.locator('input[webkitdirectory]').setInputFiles(folder);
  await importPopup.getByLabel('I have the right to share this pack.').check();
  await importPopup.getByRole('button', {name: 'Import pack'}).click();

  await expect(importPopup.getByText('Import failed: sticker set invalid', {exact: true})).toBeVisible();
  await capturePopupScreenshot(page, testInfo, 'sticker-import-api-error');
  await importPopup.getByRole('button', {name: 'Import pack'}).click();
  await expect(importPopup.getByText('Import failed: An error occurred. Please try again later.', {exact: true})).toBeVisible();
  await expect(importPopup.getByText('internal server detail', {exact: true})).toHaveCount(0);
  await capturePopupScreenshot(page, testInfo, 'sticker-import-generic-error');
});

test('copies an existing sticker set link using the configured server prefix', async({page, context}) => {
  const stickerPopup = await openSandboxStory(page, 'stickers');
  await expect(stickerPopup.locator('input[aria-label="Sticker pack link"]')).toHaveValue(
    'https://teagram.test/addstickers/sandbox_stickers'
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(page.url()).origin});
  await stickerPopup.getByRole('button', {name: 'Copy Link'}).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    'https://teagram.test/addstickers/sandbox_stickers'
  );
});

test('reports a share link lookup failure and hides its copy action', async({page}, testInfo) => {
  const stickerPopup = await openSandboxStory(page, 'stickersWithoutShareLinks');

  await expect(page.getByText('Couldn’t load the sticker set link. Check your connection and try again.')).toBeVisible();
  await expect(stickerPopup.locator('.sticker-set-share-links')).toHaveCount(0);
  await expect(stickerPopup.getByRole('button', {name: 'Copy Link'})).toHaveCount(0);
  await capturePopupScreenshot(page, testInfo, 'sticker-share-link-error');
});

test('rejects a compressed oversized zip entry while reading it in the worker', async({page}, testInfo) => {
  const archive = zipSync({'bomb.webp': new Uint8Array(4 * 1024 * 1024).fill(65)}, {level: 9});
  const forgedArchive = archive.slice();
  new DataView(forgedArchive.buffer, forgedArchive.byteOffset, forgedArchive.byteLength).setUint32(22, 0, true);
  const zipPath = testInfo.outputPath('compressed-bomb.zip');
  writeFileSync(zipPath, forgedArchive);

  await page.goto('/?popups=1');
  await page.waitForFunction(() => !!window.popupSandbox, null, {timeout: 30_000});
  await page.evaluate(() => window.popupSandbox.ready());
  expect(await openStory(page, 'stickerPackImport')).toBeNull();

  const importPopup = page.locator('.popup.active').last();
  await importPopup.locator('input[accept=".zip,application/zip"]').setInputFiles(zipPath);
  await expect(importPopup.getByText('A file inside this ZIP is larger than 512 KB.', {exact: true})).toBeVisible();
  await expect(importPopup.getByRole('button', {name: 'Import pack'})).toBeDisabled();
  await capturePopupScreenshot(page, testInfo, 'sticker-import-oversized-zip');
  expect(await page.evaluate(() => window.popupSandbox.calls()
    .filter((call) => call.manager === 'appStickersManager' && call.method === 'createStickerSet'))).toEqual([]);
});
