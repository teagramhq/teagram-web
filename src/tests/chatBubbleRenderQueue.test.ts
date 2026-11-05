import '@helpers/peerIdPolyfill';
import {describe, expect, test} from 'vitest';
import {getCurrentMessageFullMid} from '@components/chat/bubbles/renderQueue';
import {makeFullMid} from '@appManagers/utils/messages/fullMid';
import {Message} from '@layer';


const peerId = 777 as PeerId;

function makePendingDescriptionPoll(mid: number): Message.message {
  return {
    _: 'message',
    id: mid,
    mid,
    peer_id: {_: 'peerChat', chat_id: 777},
    peerId,
    date: 1,
    message: 'Poll description',
    pFlags: {out: true},
    media: {
      _: 'messageMediaPoll',
      poll: {
        _: 'poll',
        id: 'poll-1',
        hash: 0,
        pFlags: {},
        question: {_: 'textWithEntities', text: 'Question', entities: []},
        answers: []
      },
      results: {_: 'pollResults', pFlags: {}}
    }
  } as Message.message;
}

describe('chat bubble render queue', () => {
  test('keeps an acknowledged sender description poll render under its sent mid', () => {
    const pending = makePendingDescriptionPoll(3.0001);
    const finalMid = 4;
    const pendingBubble = document.createElement('div');
    const bubbles = new Map([[makeFullMid(peerId, finalMid), pendingBubble]]);
    const changedMids = new Map([[pending.mid, finalMid]]);

    const currentFullMid = getCurrentMessageFullMid(
      makeFullMid(pending),
      pending.mid,
      changedMids
    );

    expect(bubbles.get(currentFullMid)).toBe(pendingBubble);
  });

  test('drops a late temporary render once its sent bubble has a different owner', () => {
    const pending = makePendingDescriptionPoll(3.0001);
    const finalMid = 4;
    const latePendingBubble = document.createElement('div');
    const sentBubble = document.createElement('div');
    const bubbles = new Map([
      [makeFullMid(pending), latePendingBubble],
      [makeFullMid(peerId, finalMid), sentBubble]
    ]);
    const changedMids = new Map([[pending.mid, finalMid]]);

    const currentFullMid = getCurrentMessageFullMid(
      makeFullMid(pending),
      pending.mid,
      changedMids
    );

    expect(bubbles.get(currentFullMid)).not.toBe(latePendingBubble);
    expect(bubbles.get(currentFullMid)).toBe(sentBubble);
  });
});
