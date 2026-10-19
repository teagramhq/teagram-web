import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {AppMessagesManager} from '@appManagers/appMessagesManager';

const CHAT_ID = 777 as ChatId;
const PEER_ID = CHAT_ID.toPeerId(true);

function makeManager(isBroadcast: boolean) {
  const manager = new AppMessagesManager() as any;
  const invokeApi = vi.fn(() => Promise.resolve(true));
  const canSendToPeer = vi.fn(() => Promise.resolve(true));

  Object.assign(manager, {
    typings: {},
    canSendToPeer,
    appPeersManager: {
      isBroadcast: () => isBroadcast,
      isMonoforum: () => false,
      isForum: () => false,
      isBotforum: () => false,
      getInputPeerById: () => ({
        _: 'inputPeerChannel',
        channel_id: CHAT_ID,
        access_hash: '1'
      })
    },
    apiManager: {invokeApi}
  });

  return {canSendToPeer, invokeApi, manager};
}

describe('AppMessagesManager typing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not send typing actions to broadcast channels', async() => {
    const {canSendToPeer, invokeApi, manager} = makeManager(true);

    expect(await manager.setTyping(PEER_ID, {_: 'sendMessageTypingAction'})).toBe(false);
    expect(canSendToPeer).not.toHaveBeenCalled();
    expect(invokeApi).not.toHaveBeenCalled();
  });

  it('still sends typing actions to supported group chats', async() => {
    const {invokeApi, manager} = makeManager(false);

    expect(await manager.setTyping(PEER_ID, {_: 'sendMessageTypingAction'})).toBe(true);
    expect(invokeApi).toHaveBeenCalledWith('messages.setTyping', expect.objectContaining({
      peer: expect.objectContaining({_: 'inputPeerChannel'}),
      action: {_: 'sendMessageTypingAction'}
    }));
  });
});
