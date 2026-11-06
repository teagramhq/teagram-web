import {expect, test, vi} from 'vitest';
import {RootScope} from '@lib/rootScope';
import MTProtoMessagePort from '@lib/mainWorker/mainMessagePort';

test('collects all synchronous peer-save broadcasts while preserving worker listeners', () => {
  const invokeVoid = vi.fn();
  const port = vi.spyOn(MTProtoMessagePort, 'getInstance').mockReturnValue({invokeVoid} as any);
  const scope = new RootScope();
  const local = vi.fn();
  scope.addEventListener('user_update', local);
  const events: any[] = [];

  scope.collectBroadcastEvents(events, () => {
    scope.dispatchEvent('user_update', 7 as UserId);
    scope.dispatchEvent('peer_title_edit', {peerId: 7 as PeerId});
  });

  expect(local).toHaveBeenCalledOnce();
  expect(events).toEqual([
    {name: 'user_update', args: [7]},
    {name: 'peer_title_edit', args: [{peerId: 7}]}
  ]);
  expect(invokeVoid).not.toHaveBeenCalled();
  port.mockRestore();
});

test('restores normal event forwarding when a collected operation throws', async() => {
  const invokeVoid = vi.fn();
  const port = vi.spyOn(MTProtoMessagePort, 'getInstance').mockReturnValue({invokeVoid} as any);
  const scope = new RootScope();
  expect(() => scope.collectBroadcastEvents([], () => {
    throw new Error('save failed');
  })).toThrow('save failed');

  scope.dispatchEvent('user_update', 7 as UserId);
  await Promise.resolve();
  expect(invokeVoid).toHaveBeenCalledWith('event', expect.objectContaining({name: 'user_update', args: [7]}));
  port.mockRestore();
});
