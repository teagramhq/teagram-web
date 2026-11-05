import {expect, test} from 'vitest';
import {reconcilePeer, usePeers} from '@stores/peers';
import reconcilePeerMirrorBatch from '@lib/apiManagerProxyUtils/peerMirrorBatch';

test('merges batched peer mirrors into the existing mirror and peer store', () => {
  const preservedUserId = 900000001;
  const activeChannelId = 900000002;
  const activeChannelPeerId = -activeChannelId;
  const changedUserId = 900000003;
  const preservedUser = {_: 'user', id: preservedUserId, first_name: 'kept', pFlags: {}} as any;
  const oldUser = {_: 'user', id: changedUserId, first_name: 'old', phone: '123', pFlags: {}} as any;
  const nextUser = {_: 'user', id: changedUserId, first_name: 'updated', pFlags: {}} as any;
  const activeChannel = {_: 'channel', id: activeChannelId, title: 'joined', pFlags: {}} as any;
  const mirror: Record<string, any> = {[preservedUserId]: preservedUser};
  reconcilePeer(preservedUserId as PeerId, preservedUser);
  reconcilePeer(changedUserId as PeerId, oldUser);

  const newActiveChannelIds = reconcilePeerMirrorBatch(mirror, {
    [changedUserId]: nextUser,
    [activeChannelPeerId]: activeChannel
  });

  expect(mirror).toMatchObject({
    [preservedUserId]: preservedUser,
    [changedUserId]: nextUser,
    [activeChannelPeerId]: activeChannel
  });
  expect(usePeers()[preservedUserId as PeerId]).toMatchObject({first_name: 'kept'});
  expect(usePeers()[changedUserId as PeerId]).toMatchObject({first_name: 'updated'});
  expect(usePeers()[changedUserId as PeerId]).not.toHaveProperty('phone');
  expect(usePeers()[activeChannelPeerId as PeerId]).toMatchObject({title: 'joined'});
  expect(newActiveChannelIds).toEqual([activeChannelId]);
});

test('preserves active channel updates for empty-channel dialog reconciliation', () => {
  const channelId = 900000004;
  const peer = {_: 'channel', id: channelId, title: 'joined', pFlags: {}} as any;
  const mirror: Record<string, any> = {};
  const activeChannelIds = reconcilePeerMirrorBatch(mirror, {[-channelId]: peer});

  expect(mirror[-channelId]).toBe(peer);
  expect(usePeers()[-channelId as PeerId]).toMatchObject({title: 'joined'});
  expect(activeChannelIds).toEqual([channelId]);
});
