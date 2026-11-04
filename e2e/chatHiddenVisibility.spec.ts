import {expect, test} from '@playwright/test';

test('keeps a hidden chat invisible with the production chat styles', async({page}) => {
  await page.goto('/');
  await page.waitForFunction(() => Array.from(document.styleSheets).some((styleSheet) => {
    try {
      return Array.from(styleSheet.cssRules).some((rule) => 'selectorText' in rule && rule.selectorText === '.chat');
    } catch{
      return false;
    }
  }));

  const display = await page.evaluate(() => {
    const chat = document.createElement('div');
    chat.className = 'chat';
    chat.hidden = true;
    document.body.append(chat);
    const computedDisplay = getComputedStyle(chat).display;
    chat.remove();
    return computedDisplay;
  });

  expect(display).toBe('none');
});
