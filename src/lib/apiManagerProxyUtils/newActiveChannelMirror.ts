import type {Chat, User} from '@layer';

export default function getNewActiveChannelMirrorChatId(
  previousPeer: Exclude<Chat, Chat.chatEmpty> | User.user | undefined,
  nextPeer: Exclude<Chat, Chat.chatEmpty> | User.user | undefined
) {
  if(previousPeer || nextPeer?._ !== 'channel' || nextPeer.pFlags?.left || (nextPeer as any).pFlags?.kicked) {
    return;
  }

  return nextPeer.id;
}
