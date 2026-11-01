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

vi.mock('@helpers/dom/attachContextMenuListener', () => ({
  attachContextMenuListener: ({element, callback}: {element: HTMLElement, callback: (event: MouseEvent) => void}) => {
    element.addEventListener('contextmenu', callback as EventListener);
  }
}));

vi.mock('@helpers/contextMenuController', () => ({
  default: {openBtnMenu: vi.fn()}
}));

vi.mock('@helpers/dom/clickEvent', () => ({attachClickEvent: vi.fn()}));
vi.mock('@helpers/positionMenu', () => ({default: vi.fn()}));
vi.mock('@helpers/appWindow', () => ({getOverlayRoot: () => document.body}));
vi.mock('@lib/logger', () => ({logger: () => Object.assign(vi.fn(), {error: vi.fn()})}));

import createContextMenu from '@helpers/dom/createContextMenu';

test('loads and opens a context menu only when the user opens it', async() => {
  expect(mocks.moduleLoaded).toBe(false);

  const target = document.createElement('div');
  document.body.append(target);
  createContextMenu({
    buttons: [{text: 'Context item' as any, onClick: vi.fn()}],
    listenTo: target
  });
  target.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true}));

  await vi.waitFor(() => {
    expect(document.querySelector('.btn-menu')?.textContent).toBe('Context item');
  });
  expect(mocks.moduleLoaded).toBe(true);

  target.remove();
  document.querySelector('.btn-menu')?.remove();
});
