import type {Chat, User} from '@layer';

export type PeerMirrorValue = Exclude<Chat, Chat.chatEmpty> | User.user;
export type PeerMirrorBatch = (peerKey: string, peer: PeerMirrorValue) => void;
export type PeerMirrorEvent = {name: string, args: any[]};
export type PeerSaveOptions = {
  skipEmptyChannelDialogReconciliation?: boolean,
  chatUpdateIds?: Set<ChatId>
};
