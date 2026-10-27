import {describe, expect, test} from 'vitest';
import parseChatSpecificTag from '@lib/richTextProcessor/parseChatSpecificTag';

describe('parseChatSpecificTag', () => {
  test('keeps a regular tag unchanged', () => {
    expect(parseChatSpecificTag('tag')).toEqual({query: '#tag'});
    expect(parseChatSpecificTag('$TON')).toEqual({query: '$TON'});
  });

  test('separates the target chat username', () => {
    expect(parseChatSpecificTag('tag@public_channel')).toEqual({
      query: '#tag',
      username: 'public_channel'
    });
    expect(parseChatSpecificTag('$TON@public_channel')).toEqual({
      query: '$TON',
      username: 'public_channel'
    });
  });

  test('parses a short username that the server accepts', () => {
    expect(parseChatSpecificTag('tag@ab')).toEqual({
      query: '#tag',
      username: 'ab'
    });
  });

  test('leaves username syntax to the server for unicode suffixes', () => {
    expect(parseChatSpecificTag('телеграм@тест')).toEqual({
      query: '#телеграм',
      username: 'тест'
    });
    expect(parseChatSpecificTag('телеграм@telegram')).toEqual({
      query: '#телеграм',
      username: 'telegram'
    });
  });

  test('does not reject a username the server accepts by its trailing underscore', () => {
    expect(parseChatSpecificTag('tag@invalid_')).toEqual({
      query: '#tag',
      username: 'invalid_'
    });
    expect(parseChatSpecificTag('$TON@valid@extra')).toEqual({query: '$TON@valid@extra'});
  });
});
