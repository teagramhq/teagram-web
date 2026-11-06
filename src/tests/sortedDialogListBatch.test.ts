import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lib/appDialogsManager', () => ({default: {}}));
vi.mock('@components/communities/communityDialog', () => ({attachCommunityChildBadge: vi.fn()}));
vi.mock('@lib/rootScope', () => ({default: {}}));

import SortedDialogList from '@components/sortedDialogList';

function createList() {
  const scrollable = document.createElement('div');
  document.body.append(scrollable);
  return new SortedDialogList({
    appDialogsManager: {} as any, managers: {} as any, indexKey: 'index_0',
    scrollable: {container: scrollable} as any, requestItemForIdx: () => {},
    onListShrinked: () => {}, itemSize: 'medium' as any
  });
}

describe('dialog list updates', () => {
  afterEach(() => vi.useRealTimers());

  it('processes a burst in bounded batches while retaining every row', async() => {
    vi.useFakeTimers();
    const list = createList();
    const create = vi.spyOn(list, 'createItemForKey').mockImplementation(async(key) => ({
      id: key, index: key, value: {type: 'custom-sorted-dialog', value: {render: () => document.createElement('li')}} as any
    }));
    const pending = Array.from({length: 24}, (_, index) => list.add(index));

    await vi.advanceTimersToNextTimerAsync();
    expect(create.mock.calls.length).toBe(8);
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(list.getSortedItems().map((item) => item.id)).toEqual(Array.from({length: 24}, (_, i) => 23 - i));
    list.destroy();
  });

  it('starts a new row on the first tick after clearing a cancelled backlog', async() => {
    vi.useFakeTimers();
    const list = createList();
    const create = vi.spyOn(list, 'createItemForKey').mockImplementation(async(key) => ({
      id: key, index: key, value: {type: 'custom-sorted-dialog', value: {render: () => document.createElement('li')}} as any
    }));
    const cancelled = Array.from({length: 24}, (_, index) => list.add(index));
    list.clear();
    const live = list.add(99);
    await vi.advanceTimersToNextTimerAsync();
    expect(create).toHaveBeenCalledWith(99);
    await vi.runAllTimersAsync();
    await Promise.all([...cancelled, live]);
    list.destroy();
  });

  it('does not resurrect a deleted row whose creation is still pending', async() => {
    vi.useFakeTimers();
    const list = createList();
    let finish!: (item: any) => void;
    vi.spyOn(list, 'createItemForKey').mockImplementation(() => new Promise((resolve) => finish = resolve));
    const pending = list.add(1);
    await vi.advanceTimersToNextTimerAsync();
    list.delete(1);
    const destroy = vi.fn();
    finish({id: 1, index: 1, value: {type: 'dialog', value: {destroy}}});
    await pending;
    expect(list.has(1)).toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
    list.destroy();
  });

  it('keeps one row when a peer is added twice in one batch', async() => {
    vi.useFakeTimers();
    const list = createList();
    vi.spyOn(list, 'createItemForKey').mockImplementation(async(key) => ({
      id: key, index: key, value: {type: 'custom-sorted-dialog', value: {render: () => document.createElement('li')}} as any
    }));
    const pending = [list.add(1), list.add(1)];
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(list.getSortedItems().map((item) => item.id)).toEqual([1]);
    list.destroy();
  });

  it('continues starting other rows when one row is waiting for media', async() => {
    vi.useFakeTimers();
    const list = createList();
    let finish!: (item: any) => void;
    const makeItem = (key: number) => ({
      id: key, index: key, value: {type: 'custom-sorted-dialog', value: {render: () => document.createElement('li')}} as any
    });
    vi.spyOn(list, 'createItemForKey').mockImplementation((key) => key === 0 ?
      new Promise((resolve) => finish = resolve) : Promise.resolve(makeItem(key)));
    const pending = Array.from({length: 16}, (_, index) => list.add(index));
    await vi.runAllTimersAsync();
    expect(list.has(15)).toBe(true);
    finish(makeItem(0));
    await Promise.all(pending);
    expect(list.has(0)).toBe(true);
    list.destroy();
  });

  it('keeps a newer pending add when an older cancelled add completes', async() => {
    vi.useFakeTimers();
    const list = createList();
    let finish!: (item: any) => void;
    const create = vi.spyOn(list, 'createItemForKey').mockImplementationOnce(() => new Promise((resolve) => finish = resolve));
    const old = list.add(1);
    await vi.advanceTimersToNextTimerAsync();
    list.delete(1);
    const newer = list.add(1);
    finish({id: 1, index: 1, value: {type: 'dialog', value: {destroy: vi.fn()}}});
    await old;
    await Promise.resolve();
    expect(list.getPendingKeys()).toEqual([1]);
    list.cancelPending(1);
    await vi.runAllTimersAsync();
    await newer;
    expect(create).toHaveBeenCalledTimes(1);
    expect(list.has(1)).toBe(false);
    list.destroy();
  });
});
