import getNewActiveChannelMirrorChatId from '@lib/apiManagerProxyUtils/newActiveChannelMirror';

describe('new active channel mirror notifications', () => {
  const activeChannel = (id: number, pFlags: Record<string, boolean> = {}) => ({
    _: 'channel',
    id,
    pFlags
  });

  test('returns the channel id when a new active channel peer is mirrored', () => {
    expect(getNewActiveChannelMirrorChatId(undefined, activeChannel(12345) as any)).toBe(12345);
  });

  test.each([
    ['forbidden', {_:'channelForbidden', id: 12350}],
    ['left', activeChannel(12350, {left: true})],
    ['kicked', activeChannel(12350, {kicked: true})]
  ])('returns the channel id when a %s peer becomes active', (_name, previousPeer) => {
    expect(getNewActiveChannelMirrorChatId(previousPeer as any, activeChannel(12350) as any)).toBe(12350);
  });

  test.each([
    ['left', activeChannel(12346, {left: true})],
    ['kicked', activeChannel(12347, {kicked: true})],
    ['forbidden', {_:'channelForbidden', id: 12348}]
  ])('does not notify for a %s peer', (_name, peer) => {
    expect(getNewActiveChannelMirrorChatId(undefined, peer as any)).toBeUndefined();
  });

  test('does not notify for a channel peer that was already mirrored', () => {
    const channel = activeChannel(12349) as any;
    expect(getNewActiveChannelMirrorChatId(channel, channel)).toBeUndefined();
  });
});
