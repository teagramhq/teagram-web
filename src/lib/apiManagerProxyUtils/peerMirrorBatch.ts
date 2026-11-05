import type {Chat, User} from '@layer';
import {batch} from 'solid-js';
import getNewActiveChannelMirrorChatId from './newActiveChannelMirror';
import {reconcilePeer} from '@stores/peers';

type PeerMirrorValue = Exclude<Chat, Chat.chatEmpty> | User.user;
type PeerMap = {[peerId in PeerId]: PeerMirrorValue};

export default function reconcilePeerMirrorBatch(mirror: PeerMap, peers: PeerMap) {
  const newActiveChannelIds: ChatId[] = [];
  batch(() => {
    for(const peerKey in peers) {
      const peerId = +peerKey as PeerId;
      const peer = peers[peerId];
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
