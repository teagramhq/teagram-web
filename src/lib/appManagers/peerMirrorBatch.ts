import type {Chat, User} from '@layer';

export type PeerMirrorValue = Exclude<Chat, Chat.chatEmpty> | User.user;
export type PeerMirrorBatch = (peerKey: string, peer: PeerMirrorValue) => void;
export type PeerSaveOptions = {
  skipEmptyChannelDialogReconciliation?: boolean
};
