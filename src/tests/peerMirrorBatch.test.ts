import {expect, test, vi} from 'vitest';
import {reconcilePeer, usePeers} from '@stores/peers';
import reconcilePeerMirrorBatch, {dispatchPeerMirrorBatchChatUpdates, applyPeerMirrorBatch} from '@lib/apiManagerProxyUtils/peerMirrorBatch';

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

test('coalesces cached reconciliation chat updates without forwarding duplicate active-channel events', () => {
  const dispatchEvent = vi.fn();
  const dispatchEventSingle = vi.fn();

  dispatchPeerMirrorBatchChatUpdates(
    [42],
    [42, 43, 43],
    (chatId) => dispatchEvent(chatId),
    (chatId) => dispatchEventSingle(chatId)
  );

  expect(dispatchEvent).toHaveBeenCalledExactlyOnceWith(42);
  expect(dispatchEventSingle).toHaveBeenCalledExactlyOnceWith(43);
});

test('applies a changed channel mirror before delivering its update', () => {
  const channelId = 900000005;
  const peerId = -channelId;
  const mirror: Record<string, any> = {[peerId]: {_: 'channel', id: channelId, pFlags: {}, title: 'old'}};
  const next = {_: 'channel', id: channelId, pFlags: {call_active: true}, title: 'new'} as any;
  const seen: unknown[] = [];

  applyPeerMirrorBatch(mirror, {[peerId]: next}, [{name: 'chat_update', args: [channelId]}], () => {}, (event) => {
    seen.push({name: event.name, title: mirror[peerId].title, callActive: mirror[peerId].pFlags.call_active});
  });

  expect(seen).toEqual([{name: 'chat_update', title: 'new', callActive: true}]);
});

test('leaves an unchanged peer mirror in place during a reconciliation batch', () => {
  const id = 900000006;
  const existing = {_: 'user', id, first_name: 'same', pFlags: {}} as any;
  const mirror: Record<string, any> = {[id]: existing};
  reconcilePeer(id as PeerId, existing);

  reconcilePeerMirrorBatch(mirror, {[id]: {_: 'user', id, first_name: 'same', pFlags: {}} as any});

  expect(mirror[id]).toBe(existing);
});

test('applies a peer mirror that removes an undefined property', () => {
  const id = 900000007;
  const existing = {_: 'user', id, first_name: 'same', phone: undefined, pFlags: {}} as any;
  const mirror: Record<string, any> = {[id]: existing};
  const next = {_: 'user', id, first_name: 'same', pFlags: {}} as any;

  reconcilePeerMirrorBatch(mirror, {[id]: next});

  expect(mirror[id]).toBe(next);
  expect(mirror[id]).not.toHaveProperty('phone');
});

test('applies a peer mirror when nested object sharing changes', () => {
  const id = 900000008;
  const existing = {_: 'user', id, pFlags: {}, extra: [{value: 1}, {value: 1}]} as any;
  const shared = {value: 1};
  const next = {_: 'user', id, pFlags: {}, extra: [shared, shared]} as any;
  const mirror: Record<string, any> = {[id]: existing};

  reconcilePeerMirrorBatch(mirror, {[id]: next});

  expect(mirror[id]).toBe(next);
});
