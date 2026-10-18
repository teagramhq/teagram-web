import type {Chat, User} from '@layer';

type PeerMirror = {[peerId: PeerId]: Exclude<Chat, Chat.chatEmpty> | User.user};

export default function getNewActiveChannelMirrorChatId(
  previousPeer: Exclude<Chat, Chat.chatEmpty> | User.user | undefined,
  nextPeer: Exclude<Chat, Chat.chatEmpty> | User.user | undefined
) {
  const isActiveChannel = (peer: typeof previousPeer): peer is Chat.channel => (
    peer?._ === 'channel' && !peer.pFlags?.left && !(peer as any).pFlags?.kicked
  );

  if(isActiveChannel(previousPeer) || !isActiveChannel(nextPeer)) {
    return;
  }

  return nextPeer.id;
}

export function getNewActiveChannelMirrorChatIds(previousPeers: PeerMirror, nextPeers: PeerMirror) {
  return Object.keys(nextPeers).flatMap((peerId) => {
    const peerIdNumber = Number(peerId) as PeerId;
    const chatId = getNewActiveChannelMirrorChatId(previousPeers[peerIdNumber], nextPeers[peerIdNumber]);
    return chatId === undefined ? [] : [chatId];
  });
}
