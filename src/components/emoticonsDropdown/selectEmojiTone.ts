import type {EmojiSkinTone, EmojiSkinToneVariants} from '@helpers/emojiSkinTone';

export default function selectEmojiTone(options: {
  baseEmoji: string,
  variants: EmojiSkinToneVariants,
  tone: EmojiSkinTone,
  applyEmojiVariant: (baseEmoji: string, tone: EmojiSkinTone) => void,
  saveEmojiVariant: (baseEmoji: string, tone: EmojiSkinTone) => void,
  onEmojiSelected: (emoji: {emoji: string}) => void
}) {
  const {baseEmoji, variants, tone, applyEmojiVariant, saveEmojiVariant, onEmojiSelected} = options;
  applyEmojiVariant(baseEmoji, tone);
  saveEmojiVariant(baseEmoji, tone);
  onEmojiSelected({emoji: variants[tone]});
}
