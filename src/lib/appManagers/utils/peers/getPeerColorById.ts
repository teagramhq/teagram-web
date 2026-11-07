import {getHexColorFromTelegramColor, hexToRgb} from '@helpers/color';
import themeController from '@helpers/themeController';
import {HelpPeerColorOption, HelpPeerColorSet, User} from '@layer';
import {DialogColors, DialogColorsFg, getPeerColorsByPeer} from './getPeerAvatarColor';
export {getPeerAvatarColorByPeer, getPeerColorIndexById, getPeerColorIndexByPeer, getPeerColorsByPeer} from './getPeerAvatarColor';

const _DialogColorsFg = DialogColorsFg;

function replaceColors(writeIn: typeof DialogColorsFg, peerColorOptions: HelpPeerColorOption[], dark?: boolean) {
  for(const peerColorOption of peerColorOptions) {
    const colorSet = (dark ? peerColorOption.dark_colors : peerColorOption.colors) as HelpPeerColorSet.helpPeerColorSet;
    const colors = colorSet?.colors;
    if(!colors?.length) {
      continue;
    }

    const c = colors.map((color) => getHexColorFromTelegramColor(color));
    writeIn[peerColorOption.color_id] = c;
  }

  return writeIn;
}

export function makeColorsGradient(colors: string[], partSize?: number) {
  const length = colors.length;
  partSize ||= 5;
  if(length !== 3) {
    colors = colors.slice().reverse();
  }

  const str = colors.map((color, idx, arr) => {
    // const startPercents = +(idx * 100 / arr.length).toFixed(2);
    // const endPercents = +((idx + 1) * 100 / arr.length).toFixed(2);
    const startValue = idx * partSize + 'px';
    const endValue = (idx + 1) * partSize + 'px';
    return [
      `${color} ${startValue}`,
      `${color} ${endValue}`
    ].join(', ');
  }).join(', ');
  return `repeating-linear-gradient(-45deg, ${str})`;
}

export function setPeerColors(peerColorOptions: HelpPeerColorOption[], user: User.user) {
  let newColors = replaceColors(_DialogColorsFg.slice(), peerColorOptions);
  if(themeController.isNight()) {
    newColors = replaceColors(newColors, peerColorOptions, true);
  }
  DialogColorsFg.splice(0, DialogColorsFg.length, ...newColors);

  newColors.forEach((colors, index) => {
    const peerProperty = `--peer-${index}`;
    const borderBackgroundProperty = `${peerProperty}-border-background`;
    const colorRgbProperty = `${peerProperty}-color-rgb`;
    document.documentElement.style.setProperty(colorRgbProperty, hexToRgb(colors[0]).join(','));
    if(colors.length > 1) {
      const gradient = makeColorsGradient(colors);
      document.documentElement.style.setProperty(
        borderBackgroundProperty,
        gradient
      );
    } else {
      document.documentElement.style.removeProperty(borderBackgroundProperty);
    }
  });

  // set my peer color
  const myColors = getPeerColorsByPeer(user);
  const properties: [string, string, number][] = [
    ['--peer-border-background', '--primary-color', myColors.length],
    ['--message-out-peer-border-background', '--message-out-primary-color', myColors.length],
    ['--message-out-peer-1-border-background', '--message-out-primary-color', 1],
    ['--message-out-peer-2-border-background', '--message-out-primary-color', 2],
    ['--message-out-peer-3-border-background', '--message-out-primary-color', 3],
    ['--message-empty-peer-1-border-background', '--message-empty-primary-color', 1],
    ['--message-empty-peer-2-border-background', '--message-empty-primary-color', 2],
    ['--message-empty-peer-3-border-background', '--message-empty-primary-color', 3]
  ];

  properties.forEach(([peerProperty, colorProperty, length]) => {
    let borderBackground: string;
    if(length > 1) {
      const colors = [
        `rgba(var(${colorProperty}-rgb), .4)`,
        `rgba(var(${colorProperty}-rgb), .2)`,
        `var(${colorProperty})`
      ];

      if(length === 2) {
        colors.shift();
      }

      borderBackground = makeColorsGradient(colors);
    } else {
      borderBackground = `var(${colorProperty})`;
    }

    document.documentElement.style.setProperty(peerProperty, borderBackground);
  });
}
