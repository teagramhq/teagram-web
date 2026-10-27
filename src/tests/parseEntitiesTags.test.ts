import {describe, expect, test} from 'vitest';
import parseEntities from '@lib/richTextProcessor/parseEntities';

describe('parseEntities tags', () => {
  test('keeps a chat-specific hashtag in one entity', () => {
    const text = '#test@username';

    expect(parseEntities(text)).toEqual([{
      _: 'messageEntityHashtag',
      offset: 0,
      length: text.length
    }]);
  });

  test('keeps a chat-specific cashtag in one entity', () => {
    const text = '$TON@public_channel';

    expect(parseEntities(text)).toEqual([{
      _: 'messageEntityCashtag',
      offset: 0,
      length: text.length
    }]);
  });

  test('keeps an adjacent mention separate when it is not part of the tag', () => {
    expect(parseEntities('#test @username')).toEqual([{
      _: 'messageEntityHashtag',
      offset: 0,
      length: 5
    }, {
      _: 'messageEntityMention',
      offset: 6,
      length: 9
    }]);
  });

  test('recognizes a short username mention allowed by the server', () => {
    expect(parseEntities('@ab')).toEqual([{
      _: 'messageEntityMention',
      offset: 0,
      length: 3
    }]);
  });

  test('leaves punctuation outside a username mention', () => {
    expect(parseEntities('@ab,')).toEqual([{
      _: 'messageEntityMention',
      offset: 0,
      length: 3
    }]);
  });

  test('keeps bot-command captures stable after a chat-specific tag', () => {
    expect(parseEntities('#test@username /start@helper')).toEqual([{
      _: 'messageEntityHashtag',
      offset: 0,
      length: 14
    }, {
      _: 'messageEntityBotCommand',
      offset: 15,
      length: 13,
      unsafe: true
    }]);
  });

  test('keeps timestamp captures stable after a chat-specific tag', () => {
    expect(parseEntities('#test@username 1:23')).toEqual([{
      _: 'messageEntityHashtag',
      offset: 0,
      length: 14
    }, {
      _: 'messageEntityTimestamp',
      offset: 15,
      length: 4,
      raw: '1:23',
      time: 83
    }]);
  });

  test('only recognizes uppercase cashtags', () => {
    expect(parseEntities('$ton@username')).toEqual([]);
  });
});
