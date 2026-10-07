import {expect, Locator, Page, test, TestInfo} from '@playwright/test';
import {
  BASE_MANAGER_CALLS,
  expectNoUnexpectedCalls,
  expectNormalConfinement,
  installConfinement,
  trafficByContext,
  waitForFixtureMount
} from './qrFixtureTestUtils';

type FixtureOutcome = 'input-method-invalid' | 'network-bad-response-406';
type FixtureTheme = 'day' | 'night';

declare global {
  interface Window {
    __growHeightAnimations?: Array<{
      className: string,
      measuredHeight: number,
      overflow: string,
      frameHeights: Array<string | number | null>
    }>;
  }
}

const scenarios: Array<{outcome: FixtureOutcome, retry: boolean}> = [
  {outcome: 'network-bad-response-406', retry: true},
  {outcome: 'input-method-invalid', retry: false}
];
const themes: FixtureTheme[] = ['day', 'night'];
const viewports = [
  {name: '1024x768', width: 1024, height: 768},
  {name: '360x640', width: 360, height: 640}
];

type ButtonVisual = {
  active: boolean,
  focusVisible: boolean,
  outlineStyle: string,
  outlineWidth: string,
  outlineOffset: string,
  outlineColor: string,
  background: string,
  opacity: string,
  bounds: {x: number, y: number, width: number, height: number}
};

async function readButtonVisual(button: Locator): Promise<ButtonVisual> {
  return button.evaluate((element) => {
    const target = element as HTMLButtonElement;
    const style = getComputedStyle(target);
    const bounds = target.getBoundingClientRect();
    return {
      active: target === document.activeElement,
      focusVisible: target.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      outlineColor: style.outlineColor,
      background: style.backgroundColor,
      opacity: style.opacity,
      bounds: {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height}
    };
  });
}

async function resolvePrimaryTextColor(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--primary-text-color)';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

async function expectButtonBackgroundSettled(button: Locator) {
  const expectedBackground = await button.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = element.classList.contains('btn-color-primary') ?
      'var(--primary-color)' : 'transparent';
    document.body.appendChild(probe);
    const background = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return background;
  });
  await expect.poll(async() => (await readButtonVisual(button)).background).toBe(expectedBackground);
}

async function expectRingFitsClippingAncestors(button: Locator, inset: boolean) {
  const clipping = await button.evaluate((element) => {
    const target = element as HTMLElement;
    const style = getComputedStyle(target);
    const bounds = target.getBoundingClientRect();
    const outlineWidth = parseFloat(style.outlineWidth) || 0;
    const outlineOffset = parseFloat(style.outlineOffset) || 0;
    const outwardSpace = Math.max(0, outlineWidth + outlineOffset);
    const ringBounds = {
      left: bounds.left - outwardSpace,
      top: bounds.top - outwardSpace,
      right: bounds.right + outwardSpace,
      bottom: bounds.bottom + outwardSpace
    };
    const clippingAncestors: Array<{className: string, fits: boolean}> = [];
    let ancestor = target.parentElement;
    while(ancestor) {
      const ancestorStyle = getComputedStyle(ancestor);
      const clips = [ancestorStyle.overflowX, ancestorStyle.overflowY]
      .some((overflow) => ['hidden', 'clip', 'auto', 'scroll'].includes(overflow));
      if(clips) {
        const ancestorBounds = ancestor.getBoundingClientRect();
        clippingAncestors.push({
          className: typeof(ancestor.className) === 'string' ? ancestor.className : '',
          fits: ringBounds.left >= ancestorBounds.left && ringBounds.top >= ancestorBounds.top &&
            ringBounds.right <= ancestorBounds.right && ringBounds.bottom <= ancestorBounds.bottom
        });
      }
      ancestor = ancestor.parentElement;
    }

    return clippingAncestors;
  });

  expect(clipping.every((ancestor) => ancestor.fits)).toBe(true);
  if(inset) expect(clipping.some((ancestor) => ancestor.className.includes('primary-action-focus-inset'))).toBe(true);
}

async function addRevealAnimationRecorder(page: Page) {
  await page.addInitScript(() => {
    const records: NonNullable<Window['__growHeightAnimations']> = [];
    Object.defineProperty(window, '__growHeightAnimations', {value: records});
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(keyframes, options) {
      const element = this as HTMLElement;
      const className = typeof(element.className) === 'string' ? element.className : '';
      if(className.includes('primary-action-focus-inset') || className.includes('accent-picker-frame')) {
        records.push({
          className,
          measuredHeight: element.clientHeight,
          overflow: getComputedStyle(element).overflow,
          frameHeights: Array.isArray(keyframes) ? keyframes.map((frame) => frame.height ?? null) : []
        });
      }
      return animate.call(this, keyframes, options);
    };
  });
}

async function saveStateScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({path: testInfo.outputPath(`${name}.png`), fullPage: true});
}

async function expectPrimaryActionRing(
  page: Page,
  button: Locator,
  offset: '2px' | '-2px',
  testInfo: TestInfo,
  name: string,
  initiallyFocused: boolean
) {
  if(initiallyFocused) await expect(button).toBeFocused();
  if(initiallyFocused) {
    const initialFocus = await readButtonVisual(button);
    expect(initialFocus.focusVisible).toBe(true);
    expect(initialFocus.outlineStyle).toBe('solid');
    expect(initialFocus.outlineWidth).toBe('2px');
    expect(initialFocus.outlineOffset).toBe(offset);
  }

  const wasActive = await button.evaluate((element) => element === document.activeElement);
  if(wasActive) await button.evaluate((element) => (element as HTMLButtonElement).blur());
  await expectButtonBackgroundSettled(button);
  const unfocused = await readButtonVisual(button);
  expect(unfocused.focusVisible).toBe(false);
  expect(unfocused.outlineStyle).toBe('none');

  if(initiallyFocused) {
    await button.evaluate((element) => (element as HTMLButtonElement).focus());
  } else {
    await page.keyboard.press('Tab');
  }
  await expect(button).toBeFocused();
  const focused = await readButtonVisual(button);
  expect(focused.focusVisible).toBe(true);
  expect(focused.outlineStyle).toBe('solid');
  expect(focused.outlineWidth).toBe('2px');
  expect(focused.outlineOffset).toBe(offset);
  expect(focused.outlineColor).toBe(await resolvePrimaryTextColor(page));
  expect(focused.bounds).toEqual(unfocused.bounds);
  expect(focused.background).toBe(unfocused.background);
  await expectRingFitsClippingAncestors(button, offset === '-2px');
  await saveStateScreenshot(page, testInfo, name);

  await button.evaluate((element) => {
    element.addEventListener('click', (event) => event.stopImmediatePropagation(), {capture: true, once: true});
  });
  await button.hover();
  const hover = await readButtonVisual(button);
  expect(hover.focusVisible).toBe(true);
  expect(hover.outlineStyle).toBe('solid');
  const expectedHoverBackground = await button.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = element.classList.contains('btn-primary-transparent') ?
      'var(--light-primary-color)' : 'var(--dark-primary-color)';
    document.body.appendChild(probe);
    const background = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return background;
  });
  await expect.poll(async() => (await readButtonVisual(button)).background).toBe(expectedHoverBackground);
  await expectRingFitsClippingAncestors(button, offset === '-2px');
  await saveStateScreenshot(page, testInfo, `${name}-hover`);

  await page.mouse.click(0, 0);
  await button.click();
  const clicked = await readButtonVisual(button);
  expect(clicked.active).toBe(true);
  expect(clicked.focusVisible).toBe(false);
  expect(clicked.outlineStyle).toBe('none');
  await saveStateScreenshot(page, testInfo, `${name}-pointer`);
}

test.beforeEach(async({page,context}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if(typeof(baseURL) !== 'string') throw new Error('QR fixture base URL is unavailable');
  await installConfinement(page, context, baseURL);
  await addRevealAnimationRecorder(page);
});

for(const scenario of scenarios) {
  for(const theme of themes) {
    for(const viewport of viewports) {
      test(`shows primary action focus rings for ${scenario.outcome}, ${theme}, ${viewport.name}`, async({page,context}, testInfo) => {
        const traffic = trafficByContext.get(context);
        if(!traffic) throw new Error('QR fixture confinement was not installed');
        await page.setViewportSize({width: viewport.width, height: viewport.height});
        await page.goto(`/qr-fixture.html?outcome=${scenario.outcome}`, {waitUntil: 'domcontentloaded'});
        await waitForFixtureMount(page);

        if(theme === 'night') await page.evaluate(() => window.qrFixture?.setTheme('night'));
        await expect(page.locator('#qr-fixture-root')).toHaveAttribute(
          'data-qr-fixture-marker',
          'TWEB_QR_FIXTURE_DEV_ONLY_SENTINEL_6D9B42E1'
        );
        await page.locator('#qr-fixture-root').evaluate((root) => root.ownerDocument.documentElement.classList.add('no-touch'));
        await page.evaluate(() => document.documentElement.style.setProperty('--primary-color', '#ea8ced'));

        const retryButton = page.getByRole('button', {name: 'Try again', exact: true});
        const usernameButton = page.getByRole('button', {name: 'Sign in with username', exact: true});
        const passkeyButton = page.getByRole('button', {name: /Log in by passkey/});
        await expect(passkeyButton).toBeVisible();
        if(scenario.retry) {
          await expect(retryButton).toBeVisible();
          await expect(retryButton).toHaveClass(/btn-primary btn-color-primary/);
          await expect(retryButton).toBeFocused();
        } else {
          await expect(retryButton).toHaveCount(0);
          await expect(usernameButton).toHaveClass(/btn-primary/);
          await expect(usernameButton).toBeFocused();
        }
        await expectNoUnexpectedCalls(page, theme === 'night' ?
          [...BASE_MANAGER_CALLS, 'apiManager.setThemeParams'].sort() : BASE_MANAGER_CALLS);

        const insetRevealLocator = passkeyButton.locator('xpath=..');
        await expect(insetRevealLocator).toHaveCount(1, {timeout: 5000});
        const insetReveal = await insetRevealLocator.evaluate((element) => ({
          className: element.className,
          overflow: getComputedStyle(element).overflow,
          clientHeight: (element as HTMLElement).clientHeight
        }));
        expect(insetReveal.className).toBe('primary-action-focus-inset');
        expect(insetReveal.overflow).toBe('hidden');
        await expect.poll(() => page.evaluate(() => window.__growHeightAnimations?.length || 0)).toBeGreaterThan(0);
        const revealAnimation = await page.evaluate(() => window.__growHeightAnimations?.[0]);
        expect(revealAnimation?.className).toBe('primary-action-focus-inset');
        expect(revealAnimation?.overflow).toBe('hidden');
        expect(revealAnimation?.measuredHeight).toBeGreaterThan(0);
        expect(revealAnimation?.frameHeights[1]).toBe(`${revealAnimation?.measuredHeight}px`);

        const initiallyFocused = scenario.retry ? retryButton : usernameButton;
        await expectButtonBackgroundSettled(initiallyFocused);
        const initial = await readButtonVisual(initiallyFocused);
        expect(initial.focusVisible).toBe(true);
        expect(initial.outlineStyle).toBe('solid');
        expect(initial.outlineWidth).toBe('2px');
        expect(initial.outlineOffset).toBe('2px');
        expect(initial.outlineColor).toBe(await resolvePrimaryTextColor(page));
        await saveStateScreenshot(page, testInfo, `${theme}-${viewport.name}-${scenario.outcome}-initial`);

        const actions: Array<{name: string, button: Locator, offset: '2px' | '-2px'}> = scenario.retry ? [
          {name: 'try-again', button: retryButton, offset: '2px'},
          {name: 'username', button: usernameButton, offset: '2px'},
          {name: 'passkey', button: passkeyButton, offset: '-2px'}
        ] : [
          {name: 'username', button: usernameButton, offset: '2px'},
          {name: 'passkey', button: passkeyButton, offset: '-2px'}
        ];

        for(const action of actions) {
          await expectPrimaryActionRing(
            page,
            action.button,
            action.offset,
            testInfo,
            `${theme}-${viewport.name}-${scenario.outcome}-${action.name}`,
            action.button === initiallyFocused
          );
        }

        const passkeyDisabledOpacity = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--disabled-opacity')));
        await passkeyButton.evaluate((element) => {
          const button = element as HTMLButtonElement;
          button.disabled = true;
          button.focus();
        });
        await expect(passkeyButton).toBeDisabled();
        await expect.poll(async() => parseFloat((await readButtonVisual(passkeyButton)).opacity)).toBe(passkeyDisabledOpacity);
        const disabledPasskey = await readButtonVisual(passkeyButton);
        expect(disabledPasskey.active).toBe(false);
        expect(disabledPasskey.focusVisible).toBe(false);
        expect(disabledPasskey.outlineStyle).toBe('none');
        expect(parseFloat(disabledPasskey.opacity)).toBe(passkeyDisabledOpacity);
        await saveStateScreenshot(page, testInfo, `${theme}-${viewport.name}-${scenario.outcome}-disabled-passkey`);

        await expectNormalConfinement(page, context, traffic);
      });
    }
  }
}

for(const theme of themes) {
  for(const viewport of viewports) {
    test(`preserves keyboard focus through retry loading, ${theme}, ${viewport.name}`, async({page,context}, testInfo) => {
      const traffic = trafficByContext.get(context);
      if(!traffic) throw new Error('QR fixture confinement was not installed');
      await page.setViewportSize({width: viewport.width, height: viewport.height});
      await page.goto('/qr-fixture.html?outcome=network-bad-response-406', {waitUntil: 'domcontentloaded'});
      await waitForFixtureMount(page);
      if(theme === 'night') await page.evaluate(() => window.qrFixture?.setTheme('night'));

      const retryButton = page.getByRole('button', {name: 'Try again', exact: true});
      const usernameButton = page.getByRole('button', {name: 'Sign in with username', exact: true});
      await expect(retryButton).toBeFocused();
      const beforeRetry = await readButtonVisual(retryButton);
      expect(beforeRetry.focusVisible).toBe(true);
      expect(beforeRetry.outlineStyle).toBe('solid');
      await page.evaluate(() => window.qrFixture?.selectOutcome('token'));
      await page.keyboard.press('Enter');

      await expect(page.locator('#qr-fixture-root .preloader')).toBeVisible();
      await expect(retryButton).toHaveCount(0);
      await expect(usernameButton).toBeFocused();
      const username = await readButtonVisual(usernameButton);
      expect(username.focusVisible).toBe(true);
      expect(username.outlineStyle).toBe('solid');
      expect(username.outlineWidth).toBe('2px');
      expect(username.outlineOffset).toBe('2px');
      expect(username.outlineColor).toBe(await resolvePrimaryTextColor(page));
      await saveStateScreenshot(page, testInfo, `${theme}-${viewport.name}-retry-loading`);
      await expectNoUnexpectedCalls(page, theme === 'night' ?
        [...BASE_MANAGER_CALLS, 'apiManager.setThemeParams'].sort() : BASE_MANAGER_CALLS);
      await expectNormalConfinement(page, context, traffic);
    });
  }
}

test('preserves GrowHeightReveal clipping, measurement and hide/show behavior for existing consumers', async({page,context}, testInfo) => {
  const traffic = trafficByContext.get(context);
  if(!traffic) throw new Error('QR fixture confinement was not installed');
  await page.goto('/qr-fixture.html?outcome=input-method-invalid', {waitUntil: 'domcontentloaded'});
  await waitForFixtureMount(page);

  const accentProbe = page.locator('[data-qr-fixture-reveal-probe="accent"]');
  const passkeyProbe = page.locator('[data-qr-fixture-reveal-probe="passkey"]');
  const accentFrame = accentProbe.locator('xpath=..');
  const passkeyFrame = passkeyProbe.locator('xpath=..');
  await expect(accentProbe).toHaveCount(0);
  await expect(passkeyProbe).toHaveCount(0);

  await page.evaluate(() => window.qrFixture?.setRevealProbeVisible(true));
  await expect(accentProbe).toBeVisible();
  await expect(passkeyProbe).toBeVisible();
  const visibleFrames = await Promise.all([accentFrame, passkeyFrame].map((frame) => frame.evaluate((element) => ({
    className: element.className,
    overflow: getComputedStyle(element).overflow,
    childClassName: element.firstElementChild?.className
  }))));
  expect(visibleFrames).toEqual([
    {className: 'accent-picker-frame', overflow: 'hidden', childClassName: 'accent-picker'},
    {className: 'primary-action-focus-inset', overflow: 'hidden', childClassName: 'btn-primary btn-primary-transparent'}
  ]);

  await expect.poll(() => page.evaluate(() => window.__growHeightAnimations?.filter((record) =>
    record.className === 'accent-picker-frame' || record.className === 'primary-action-focus-inset').length || 0))
  .toBeGreaterThan(1);
  const revealMeasurements = await page.evaluate(() => window.__growHeightAnimations?.filter((record) =>
    record.className === 'accent-picker-frame' || record.className === 'primary-action-focus-inset'));
  expect(revealMeasurements?.some((record) => record.className === 'accent-picker-frame')).toBe(true);
  expect(revealMeasurements?.some((record) => record.className === 'primary-action-focus-inset')).toBe(true);
  for(const record of revealMeasurements || []) {
    expect(record.measuredHeight).toBeGreaterThan(0);
    expect(record.frameHeights[1]).toBe(`${record.measuredHeight}px`);
  }
  await saveStateScreenshot(page, testInfo, 'grow-height-reveal-visible');

  await page.evaluate(() => window.qrFixture?.setRevealProbeVisible(false));
  await expect(accentProbe).toHaveCount(0);
  await expect(passkeyProbe).toHaveCount(0);
  await expect(page.getByRole('button', {name: /Log in by passkey/}).locator('xpath=..')).toHaveCount(1);
  await saveStateScreenshot(page, testInfo, 'grow-height-reveal-hidden');

  await page.evaluate(() => window.qrFixture?.setRevealProbeVisible(true));
  await expect(accentProbe).toBeVisible();
  await expect(passkeyProbe).toBeVisible();
  await saveStateScreenshot(page, testInfo, 'grow-height-reveal-restored');
  await expectNormalConfinement(page, context, traffic);
});
