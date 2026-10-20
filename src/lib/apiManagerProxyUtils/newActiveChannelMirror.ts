import type {Chat, User} from '@layer';

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
