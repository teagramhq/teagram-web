import {describe, expect, it} from 'vitest';
import {createReactionPickerEmojiTab} from '@components/chat/reactionsMenuEmojiAccess';

describe('reaction picker custom emoji access', () => {
  class EmojiTabMock {
    constructor(public options: object) {}
  }

  it.each([
    {isTags: false, isEffects: false, expected: true},
    {isTags: true, isEffects: false, expected: false},
    {isTags: false, isEffects: true, expected: false}
  ])('passes the right Premium gate into EmojiTab: $isTags tags, $isEffects effects', ({isTags, isEffects, expected}) => {
    const pickerOptions = {noRegularEmoji: true, noPacks: true, managers: {} as never};
    const picker = createReactionPickerEmojiTab(
      pickerOptions,
      isTags,
      isEffects,
      (options) => new EmojiTabMock(options)
    );

    expect(picker.options).toEqual({...pickerOptions, canUsePremiumEmojiAlways: expected});
  });
});
