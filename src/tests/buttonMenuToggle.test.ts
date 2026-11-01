import {expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  moduleLoaded: false
}));

vi.mock('@components/buttonMenu', () => {
  mocks.moduleLoaded = true;
  return {
    default: async({buttons}: {buttons: Array<{text?: string}>}) => {
      const menu = document.createElement('div');
      menu.classList.add('btn-menu');
      menu.textContent = buttons.map((button) => button.text).join('');
      return menu;
    }
  };
});

vi.mock('@helpers/schedulers', async(importOriginal) => {
  const original = await importOriginal<typeof import('@helpers/schedulers')>();
  return {
    ...original,
    doubleRaf: async() => {}
  };
});

vi.mock('@helpers/dom/clickEvent', () => ({
  CLICK_EVENT_NAME: 'click',
  hasMouseMovedSinceDown: () => false
}));

import ButtonMenuToggle from '@components/buttonMenuToggle';

test('loads and opens a button menu only when the user opens its trigger', async() => {
  expect(mocks.moduleLoaded).toBe(false);

  const button = ButtonMenuToggle({
    direction: 'bottom-left',
    buttons: [{text: 'Menu item' as any, onClick: vi.fn()}]
  });
  document.body.append(button);
  button.click();

  await vi.waitFor(() => {
    expect(document.querySelector('.btn-menu')?.textContent).toBe('Menu item');
  });
  expect(mocks.moduleLoaded).toBe(true);

  button.remove();
  document.querySelector('.btn-menu')?.remove();
});
