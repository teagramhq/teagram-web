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
