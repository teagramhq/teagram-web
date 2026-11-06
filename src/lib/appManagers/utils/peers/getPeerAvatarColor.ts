import {hexaToHsla} from '@helpers/color';
import type {Chat, PeerColor, User} from '@layer';

export const DialogColorsFg: Array<string[]> = [['#CC5049'], ['#D67722'], ['#955CDB'], ['#40A920'], ['#309EBA'], ['#368AD1'], ['#C7508B']];
export const DialogColors = ['red', 'orange', 'violet', 'green', 'cyan', 'blue', 'pink'] as const;

export function getPeerColorIndexById(peerId: UserId | ChatId) {
  return Math.abs(+peerId) % 7;
}

export function getPeerColorIndexByPeer(peer: Chat | User) {
  if(!peer) return -1;
  const peerColor = (peer as User.user).color;
  return (peerColor as PeerColor.peerColor)?.color ?? getPeerColorIndexById(peer.id);
}

export function getPeerColorsByPeer(peer: Chat | User) {
  const colorIndex = getPeerColorIndexByPeer(peer);
  return DialogColorsFg[colorIndex] ?? [];
}

export function getPeerAvatarColorByPeer(peer: Chat | User) {
  let idx = getPeerColorIndexByPeer(peer);
  if(idx === -1) {
    return;
  }

  let color = DialogColors[idx];
  if(!color) {
    const fgColor = DialogColorsFg[idx];
    if(!fgColor) {
      return DialogColors[getPeerColorIndexById(peer.id)];
    }

    const hue = hexaToHsla(fgColor[0]).h;
    if(hue >= 345 || hue < 29) idx = 0; // red
    else if(hue < 67) idx = 1; // orange
    else if(hue < 140) idx = 3; // green
    else if(hue < 199) idx = 4; // cyan
    else if(hue < 234) idx = 5; // blue
    else if(hue < 301) idx = 2; // violet
    else idx = 6; // pink

    color = DialogColors[idx];
  }

  return color;
}
