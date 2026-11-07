import {describe, expect, it} from 'vitest';
import {canReactionPickerUseCustomEmoji} from '@components/chat/reactionsMenuEmojiAccess';

describe('reaction picker custom emoji access', () => {
  it.each([
    {isTags: false, isEffects: false, expected: true},
    {isTags: true, isEffects: false, expected: false},
    {isTags: false, isEffects: true, expected: false}
  ])('unlocks reactions only: $isTags tags, $isEffects effects', ({isTags, isEffects, expected}) => {
    expect(canReactionPickerUseCustomEmoji(isTags, isEffects)).toBe(expected);
  });
});
