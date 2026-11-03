import lang from '@/lang';

describe('main chat empty placeholder', () => {
  test('uses the baseline one-line copy without upstream app links', () => {
    expect(lang['ChatList.Main.EmptyPlaceholder.Title']).toBe('Your chats will be here');
    expect(lang).not.toHaveProperty('ChatList.Main.EmptyPlaceholder.Subtitle');
    expect(lang).not.toHaveProperty('ChatList.Main.EmptyPlaceholder.SubtitleNoContacts');
  });
});
