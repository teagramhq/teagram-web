import type EmojiTab from '@components/emoticonsDropdown/tabs/emoji';

type EmojiTabOptions = ConstructorParameters<typeof EmojiTab>[0];

export function createReactionPickerEmojiTab<TPicker>(
  options: Omit<EmojiTabOptions, 'canUsePremiumEmojiAlways'>,
  isTags: boolean,
  isEffects: boolean,
  createPicker: (options: EmojiTabOptions) => TPicker
) {
  return createPicker({...options, canUsePremiumEmojiAlways: !isTags && !isEffects});
}
