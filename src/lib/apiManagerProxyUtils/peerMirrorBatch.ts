import type {Chat, User} from '@layer';
import {batch} from 'solid-js';
import getNewActiveChannelMirrorChatId from './newActiveChannelMirror';
import {reconcilePeer} from '@stores/peers';
import type {PeerMirrorEvent} from '@appManagers/peerMirrorBatch';

type PeerMirrorValue = Exclude<Chat, Chat.chatEmpty> | User.user;
type PeerMap = {[peerId in PeerId]: PeerMirrorValue};

function samePlainValue(
  left: any,
  right: any,
  seen = new WeakMap<object, object>(),
  reverseSeen = new WeakMap<object, object>()
): boolean {
  if(left === right) return true;
  if(!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const prototype = Object.getPrototypeOf(left);
  if(prototype !== Object.getPrototypeOf(right) || (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)) return false;
  if(Array.isArray(left) && left.length !== right.length) return false;
  if(seen.has(left) || reverseSeen.has(right)) return seen.get(left) === right && reverseSeen.get(right) === left;
  seen.set(left, right);
  reverseSeen.set(right, left);
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) && samePlainValue(left[key], right[key], seen, reverseSeen)
  );
}

export default function reconcilePeerMirrorBatch(mirror: PeerMap, peers: PeerMap) {
  const newActiveChannelIds: ChatId[] = [];
  batch(() => {
    for(const peerKey in peers) {
      const peerId = +peerKey as PeerId;
      const peer = peers[peerId];
      if(mirror[peerId] && samePlainValue(mirror[peerId], peer)) continue;
      const newActiveChannelId = getNewActiveChannelMirrorChatId(mirror[peerId], peer);
      if(newActiveChannelId !== undefined) {
        newActiveChannelIds.push(newActiveChannelId);
      }

      reconcilePeer(peerId, peer);
      mirror[peerId] = peer;
    }
  });
  return newActiveChannelIds;
}

export function dispatchPeerMirrorBatchChatUpdates(
  activeChannelIds: Iterable<ChatId>,
  chatUpdateIds: Iterable<ChatId>,
  dispatchActiveChannelUpdate: (chatId: ChatId) => void,
  dispatchBatchedChatUpdate: (chatId: ChatId) => void
) {
  const pendingChatUpdateIds = new Set(chatUpdateIds);
  for(const chatId of activeChannelIds) {
    pendingChatUpdateIds.delete(chatId);
    dispatchActiveChannelUpdate(chatId);
  }
  pendingChatUpdateIds.forEach(dispatchBatchedChatUpdate);
}

export function applyPeerMirrorBatch(
  mirror: PeerMap,
  peers: PeerMap,
  events: PeerMirrorEvent[],
  dispatchActiveChannelUpdate: (chatId: ChatId) => void,
  dispatchEvent: (event: PeerMirrorEvent) => void,
  suppressedActiveChatUpdateIds: ChatId[] = []
) {
  const suppressed = new Set(suppressedActiveChatUpdateIds);
  for(const event of events) {
    if(event.name === 'chat_update') suppressed.add(event.args[0]);
  }
  for(const chatId of reconcilePeerMirrorBatch(mirror, peers)) {
    if(!suppressed.has(chatId)) dispatchActiveChannelUpdate(chatId);
  }
  events.forEach(dispatchEvent);
}
