import {AvailableReaction, Reaction} from '@layer';
import {AppReactionsManager} from '@appManagers/appReactionsManager';
import '@helpers/peerIdPolyfill';

const userPeerId = (200 as UserId).toPeerId(false);

describe('AppReactionsManager private chat reactions', () => {
  it('falls back to active available reactions when the server has no top reactions', async() => {
    const availableReaction = {
      _: 'availableReaction',
      reaction: '👍',
      title: 'Thumbs Up',
      pFlags: {}
    } as AvailableReaction;
    const manager = Object.assign(Object.create(AppReactionsManager.prototype), {
      getActiveAvailableReactions: (): AvailableReaction[] => [availableReaction],
      getTopReactions: (): Reaction[] => [],
      getQuickReaction: () => ({_: 'reactionEmoji', emoticon: '👍'} as Reaction)
    }) as AppReactionsManager;

    expect(await manager.getAvailableReactionsForPeer(userPeerId)).toEqual({
      type: 'chatReactionsAll',
      reactions: [{_: 'reactionEmoji', emoticon: '👍'}]
    });
  });

  it('keeps the server top reactions when they are available', async() => {
    const topReaction = {_: 'reactionEmoji', emoticon: '🔥'} as Reaction;
    const manager = Object.assign(Object.create(AppReactionsManager.prototype), {
      getActiveAvailableReactions: (): AvailableReaction[] => [],
      getTopReactions: () => [topReaction],
      getQuickReaction: () => ({_: 'reactionEmoji', emoticon: '👍'} as Reaction)
    }) as AppReactionsManager;

    expect(await manager.getAvailableReactionsForPeer(userPeerId)).toEqual({
      type: 'chatReactionsAll',
      reactions: [topReaction]
    });
  });

  it('keeps the available reactions when there is no configured quick reaction', () => {
    const availableReaction = {
      _: 'availableReaction',
      reaction: '👍',
      title: 'Thumbs Up',
      pFlags: {}
    } as AvailableReaction;
    const manager = Object.assign(Object.create(AppReactionsManager.prototype), {
      getActiveAvailableReactions: (): AvailableReaction[] => [availableReaction],
      getTopReactions: (): Reaction[] => [],
      getQuickReaction: (): undefined => undefined
    }) as AppReactionsManager;

    expect(manager.getAvailableReactionsForPeer(userPeerId, true)).toEqual({
      type: 'chatReactionsAll',
      reactions: [{_: 'reactionEmoji', emoticon: '👍'}]
    });
  });
});
