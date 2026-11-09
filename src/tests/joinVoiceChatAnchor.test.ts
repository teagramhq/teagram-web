import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Message} from '@layer';
import wrapJoinVoiceChatAnchor from '@components/wrappers/joinVoiceChatAnchor';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('voice chat invitation anchors', () => {
  it('routes a click through the Telegram voice chat handler', () => {
    const voiceChatHandler = vi.fn();
    vi.stubGlobal('tg_voicechat', voiceChatHandler);
    const message = {
      peerId: {toChatId: () => 42},
      action: {
        _: 'messageActionInviteToGroupCall',
        call: {_: 'inputGroupCall', id: '700', access_hash: '701'}
      }
    } as unknown as Message.messageService;

    const anchor = wrapJoinVoiceChatAnchor(message) as HTMLAnchorElement;
    const event = new MouseEvent('click', {bubbles: true, cancelable: true});
    anchor.dispatchEvent(event);

    expect(voiceChatHandler).toHaveBeenCalledWith(anchor, event);
  });
});
