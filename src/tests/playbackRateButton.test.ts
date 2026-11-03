import {expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  moduleLoaded: false,
  openedMenus: [] as HTMLElement[]
}));

vi.mock('@components/buttonMenu', () => {
  mocks.moduleLoaded = true;
  return {
    ButtonMenuSync: ({buttons}: {buttons: Array<{regularText?: string}>}) => {
      const menu = document.createElement('div');
      menu.classList.add('btn-menu');
      menu.textContent = buttons.map((button) => button.regularText).join('');
      return menu;
    }
  };
});

vi.mock('@components/appMediaPlaybackController', () => ({default: {playbackRate: 1}}));
vi.mock('@components/buttonIcon', () => ({
  default: (className: string) => {
    const button = document.createElement('button');
    button.className = className;
    return button;
  }
}));
vi.mock('@components/icon', () => ({default: () => document.createElement('span')}));
vi.mock('@helpers/dom/clickEvent', () => ({
  CLICK_EVENT_NAME: 'click',
  hasMouseMovedSinceDown: () => false
}));
vi.mock('@helpers/contextMenuController', () => ({
  default: {
    close: vi.fn(),
    openBtnMenu: (menu: HTMLElement) => mocks.openedMenus.push(menu)
  }
}));
vi.mock('@helpers/schedulers', async(importOriginal) => {
  const original = await importOriginal<typeof import('@helpers/schedulers')>();
  return {...original, doubleRaf: async() => {}};
});

import {PlaybackRateButton} from '@components/playbackRateButton';

test('loads the playback menu only when opened', async() => {
  expect(mocks.moduleLoaded).toBe(false);

  const playbackRateButton = PlaybackRateButton({direction: 'bottom-left'});
  expect(mocks.moduleLoaded).toBe(false);

  document.body.append(playbackRateButton.element);
  playbackRateButton.element.click();

  await vi.waitFor(() => expect(mocks.openedMenus).toHaveLength(1));
  expect(mocks.moduleLoaded).toBe(true);
  expect(mocks.openedMenus[0].textContent).toBe('0.5x1x1.5x2x');
});
