import {expect, test} from 'vitest';
import {ChatType} from '@components/chat/chatType';
import canHandleChatArrowShortcut from '@lib/canHandleChatArrowShortcut';

test('does not handle chat arrow shortcuts before chat initialization', () => {
  expect(canHandleChatArrowShortcut(undefined)).toBe(false);
});

test('handles chat arrow shortcuts for an initialized non-scheduled chat', () => {
  expect(canHandleChatArrowShortcut({type: ChatType.Chat})).toBe(true);
});

test('does not handle chat arrow shortcuts in scheduled messages', () => {
  expect(canHandleChatArrowShortcut({type: ChatType.Scheduled})).toBe(false);
});
