import type {SendMessageAction} from '@layer';
import type {LangPackKey} from '@lib/langPack';

export type TypingPeerKind = 'private' | 'chat' | 'multi' | 'pair';

const NAMES: Partial<Record<SendMessageAction['_'], string>> = {
  sendMessageTypingAction: 'TypingText',
  sendMessageUploadAudioAction: 'SendingFile',
  sendMessageUploadDocumentAction: 'SendingFile',
  sendMessageUploadPhotoAction: 'SendingPhoto',
  sendMessageUploadVideoAction: 'SendingVideo',
  sendMessageUploadRoundAction: 'SendingVideo',
  sendMessageRecordVideoAction: 'RecordingVideo',
  sendMessageRecordAudioAction: 'RecordingAudio',
  sendMessageRecordRoundAction: 'RecordingVideo',
  sendMessageGamePlayAction: 'PlayingGame',
  sendMessageChooseStickerAction: 'ChoosingSticker',
  sendMessageEmojiInteractionSeen: 'EnjoyingAnimations'
};

/** The status line for someone typing; the multi-person lines are only worded for a few actions. */
export default function getTypingLangPackKey(kind: TypingPeerKind, action: SendMessageAction['_']) {
  const name = NAMES[action];
  const grouped = kind === 'multi' || kind === 'pair';
  if(!name || (grouped && action === 'sendMessageEmojiInteractionSeen')) {
    return;
  }

  return `Peer.Activity.${kind === 'private' ? 'User' : 'Chat'}.${kind === 'multi' ? 'Multi.' : kind === 'pair' ? 'Pair.' : ''}${name}${kind === 'multi' ? '1' : ''}` as LangPackKey;
}
