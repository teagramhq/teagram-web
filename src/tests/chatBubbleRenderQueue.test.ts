import '@helpers/peerIdPolyfill';
import {describe, expect, test} from 'vitest';
import {getCurrentMessageFullMid, renderHistoryInChunks} from '@components/chat/bubbles/renderQueue';
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

describe('renderHistoryInChunks', () => {
  test('renders chunks in order and yields between them', async() => {
    const events: string[] = [];
    await renderHistoryInChunks([1, 2, 3, 4, 5], 2, async(chunk) => {
      events.push('render:' + chunk.join(','));
    }, async() => {
      events.push('yield');
    });

    expect(events).toEqual(['render:1,2', 'yield', 'render:3,4', 'yield', 'render:5']);
  });

  test('does not start the next chunk before the previous one settles', async() => {
    const events: string[] = [];
    let release: () => void;
    const first = new Promise<void>((resolve) => release = resolve);
    const done = renderHistoryInChunks([1, 2, 3], 2, (chunk) => {
      events.push('render:' + chunk.join(','));
      return chunk[0] === 1 ? first : Promise.resolve();
    }, async() => {
      events.push('yield');
    });

    await Promise.resolve();
    expect(events).toEqual(['render:1,2']);
    release();
    await done;
    expect(events).toEqual(['render:1,2', 'yield', 'render:3']);
  });

  test('stops when the caller is no longer current', async() => {
    const rendered: number[][] = [];
    let current = true;
    await renderHistoryInChunks([1, 2, 3, 4], 2, async(chunk) => {
      rendered.push(chunk);
      current = false;
    }, async() => {}, () => current);

    expect(rendered).toEqual([[1, 2]]);
  });

  test('renders a short list as one chunk without yielding', async() => {
    const events: string[] = [];
    await renderHistoryInChunks([1, 2], 8, async(chunk) => {
      events.push('render:' + chunk.join(','));
    }, async() => {
      events.push('yield');
    });

    expect(events).toEqual(['render:1,2']);
  });
});
