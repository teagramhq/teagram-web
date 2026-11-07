export function canReactionPickerUseCustomEmoji(isTags: boolean, isEffects: boolean) {
  return !isTags && !isEffects;
}
