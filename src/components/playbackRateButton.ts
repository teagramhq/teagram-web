
import appMediaPlaybackController from '@components/appMediaPlaybackController';
import type {ButtonMenuSync} from '@components/buttonMenu';
import {ButtonMenuToggleHandler} from '@components/buttonMenuToggle';
import ButtonIcon from '@components/buttonIcon';
import Icon from '@components/icon';

export const PlaybackRateButton = (options: {
  onPlaybackRateMenuToggle?: (open: boolean) => void,
  direction: string
}) => {
  const PLAYBACK_RATES = [0.5, 1, 1.5, 2];
  const PLAYBACK_RATES_ICONS: Icon[] = ['playback_05', 'playback_1x', 'playback_15', 'playback_2x'];
  const button = ButtonIcon(` btn-menu-toggle`, {noRipple: true});

  const setIcon = () => {
    const playbackRateButton = button;

    let idx = PLAYBACK_RATES.indexOf(appMediaPlaybackController.playbackRate);
    if(idx === -1) idx = PLAYBACK_RATES.indexOf(1);

    const icon = Icon(PLAYBACK_RATES_ICONS[idx]);
    if(playbackRateButton.firstElementChild) {
      playbackRateButton.firstElementChild.replaceWith(icon);
    } else {
      playbackRateButton.append(icon);
    }
  };

  let menuPromise: Promise<HTMLElement>;
  const getMenu = () => {
    if(!menuPromise) {
      menuPromise = import('@components/buttonMenu').then(({ButtonMenuSync}) => {
        const buttons = PLAYBACK_RATES.map((rate) => ({
          regularText: rate + 'x',
          onClick: () => {
            appMediaPlaybackController.playbackRate = rate;
          }
        }));
        const menu = ButtonMenuSync({buttons});
        menu.classList.add(options.direction, 'playback-rate-menu');
        button.append(menu);
        return menu;
      }).catch((error) => {
        menuPromise = undefined;
        throw error;
      });
    }

    return menuPromise;
  };

  const setBtnMenuToggle = () => {
    ButtonMenuToggleHandler({
      el: button,
      onOpen: async() => {
        const menu = await getMenu();
        options.onPlaybackRateMenuToggle?.(true);
        return menu;
      },
      onClose: options.onPlaybackRateMenuToggle ? () => {
        options.onPlaybackRateMenuToggle(false);
      } : undefined
    });
    setIcon();
  };

  const addRate = (add: number) => {
    const playbackRate = appMediaPlaybackController.playbackRate;
    const idx = PLAYBACK_RATES.indexOf(playbackRate);
    const nextIdx = idx + add;
    if(nextIdx >= 0 && nextIdx < PLAYBACK_RATES.length) {
      appMediaPlaybackController.playbackRate = PLAYBACK_RATES[nextIdx];
    }
  };

  const isMenuOpen = () => {
    return button.classList.contains('menu-open');
  };

  setBtnMenuToggle();
  return {element: button, setIcon, addRate, isMenuOpen};
};
