import type {SendMessageAction} from '@layer';
import getTypingLangPackKey, {type TypingPeerKind} from '@lib/typingLangPackKey';

const expected: Record<TypingPeerKind, Record<string, string>> = {
  private: {
    'sendMessageTypingAction': 'Peer.Activity.User.TypingText',
    'sendMessageUploadAudioAction': 'Peer.Activity.User.SendingFile',
    'sendMessageUploadDocumentAction': 'Peer.Activity.User.SendingFile',
    'sendMessageUploadPhotoAction': 'Peer.Activity.User.SendingPhoto',
    'sendMessageUploadVideoAction': 'Peer.Activity.User.SendingVideo',
    'sendMessageUploadRoundAction': 'Peer.Activity.User.SendingVideo',
    'sendMessageRecordVideoAction': 'Peer.Activity.User.RecordingVideo',
    'sendMessageRecordAudioAction': 'Peer.Activity.User.RecordingAudio',
    'sendMessageRecordRoundAction': 'Peer.Activity.User.RecordingVideo',
    'sendMessageGamePlayAction': 'Peer.Activity.User.PlayingGame',
    'sendMessageChooseStickerAction': 'Peer.Activity.User.ChoosingSticker',
    'sendMessageEmojiInteractionSeen': 'Peer.Activity.User.EnjoyingAnimations'
  },
  chat: {
    'sendMessageTypingAction': 'Peer.Activity.Chat.TypingText',
    'sendMessageUploadAudioAction': 'Peer.Activity.Chat.SendingFile',
    'sendMessageUploadDocumentAction': 'Peer.Activity.Chat.SendingFile',
    'sendMessageUploadPhotoAction': 'Peer.Activity.Chat.SendingPhoto',
    'sendMessageUploadVideoAction': 'Peer.Activity.Chat.SendingVideo',
    'sendMessageUploadRoundAction': 'Peer.Activity.Chat.SendingVideo',
    'sendMessageRecordVideoAction': 'Peer.Activity.Chat.RecordingVideo',
    'sendMessageRecordAudioAction': 'Peer.Activity.Chat.RecordingAudio',
    'sendMessageRecordRoundAction': 'Peer.Activity.Chat.RecordingVideo',
    'sendMessageGamePlayAction': 'Peer.Activity.Chat.PlayingGame',
    'sendMessageChooseStickerAction': 'Peer.Activity.Chat.ChoosingSticker',
    'sendMessageEmojiInteractionSeen': 'Peer.Activity.Chat.EnjoyingAnimations'
  },
  multi: {
    'sendMessageTypingAction': 'Peer.Activity.Chat.Multi.TypingText1',
    'sendMessageUploadAudioAction': 'Peer.Activity.Chat.Multi.SendingFile1',
    'sendMessageUploadDocumentAction': 'Peer.Activity.Chat.Multi.SendingFile1',
    'sendMessageUploadPhotoAction': 'Peer.Activity.Chat.Multi.SendingPhoto1',
    'sendMessageUploadVideoAction': 'Peer.Activity.Chat.Multi.SendingVideo1',
    'sendMessageUploadRoundAction': 'Peer.Activity.Chat.Multi.SendingVideo1',
    'sendMessageRecordVideoAction': 'Peer.Activity.Chat.Multi.RecordingVideo1',
    'sendMessageRecordAudioAction': 'Peer.Activity.Chat.Multi.RecordingAudio1',
    'sendMessageRecordRoundAction': 'Peer.Activity.Chat.Multi.RecordingVideo1',
    'sendMessageGamePlayAction': 'Peer.Activity.Chat.Multi.PlayingGame1',
    'sendMessageChooseStickerAction': 'Peer.Activity.Chat.Multi.ChoosingSticker1'
  },
  pair: {
    'sendMessageTypingAction': 'Peer.Activity.Chat.Pair.TypingText',
    'sendMessageUploadAudioAction': 'Peer.Activity.Chat.Pair.SendingFile',
    'sendMessageUploadDocumentAction': 'Peer.Activity.Chat.Pair.SendingFile',
    'sendMessageUploadPhotoAction': 'Peer.Activity.Chat.Pair.SendingPhoto',
    'sendMessageUploadVideoAction': 'Peer.Activity.Chat.Pair.SendingVideo',
    'sendMessageUploadRoundAction': 'Peer.Activity.Chat.Pair.SendingVideo',
    'sendMessageRecordVideoAction': 'Peer.Activity.Chat.Pair.RecordingVideo',
    'sendMessageRecordAudioAction': 'Peer.Activity.Chat.Pair.RecordingAudio',
    'sendMessageRecordRoundAction': 'Peer.Activity.Chat.Pair.RecordingVideo',
    'sendMessageGamePlayAction': 'Peer.Activity.Chat.Pair.PlayingGame',
    'sendMessageChooseStickerAction': 'Peer.Activity.Chat.Pair.ChoosingSticker'
  }
};

const everyAction: SendMessageAction['_'][] = [
  'inputSendMessageRichMessageDraftAction',
  'sendMessageCancelAction',
  'sendMessageChooseContactAction',
  'sendMessageChooseStickerAction',
  'sendMessageEmojiInteraction',
  'sendMessageEmojiInteractionSeen',
  'sendMessageGamePlayAction',
  'sendMessageGeoLocationAction',
  'sendMessageHistoryImportAction',
  'sendMessageRecordAudioAction',
  'sendMessageRecordRoundAction',
  'sendMessageRecordVideoAction',
  'sendMessageRichMessageDraftAction',
  'sendMessageTextDraftAction',
  'sendMessageTypingAction',
  'sendMessageUploadAudioAction',
  'sendMessageUploadDocumentAction',
  'sendMessageUploadPhotoAction',
  'sendMessageUploadRoundAction',
  'sendMessageUploadVideoAction',
  'speakingInGroupCallAction'
];

describe('typing text keys', () => {
  test.each(Object.keys(expected) as TypingPeerKind[])('%s resolves every action as before', (kind) => {
    for(const action of everyAction) {
      expect(getTypingLangPackKey(kind, action), `${kind} ${action}`).toBe(expected[kind][action]);
    }
  });

  test('every key the old tables held is covered', () => {
    for(const kind of Object.keys(expected) as TypingPeerKind[]) {
      for(const action of Object.keys(expected[kind])) {
        expect(everyAction as readonly string[]).toContain(action);
      }
    }
  });
});
