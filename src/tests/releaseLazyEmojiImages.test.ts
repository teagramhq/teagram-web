import {describe, expect, test, vi} from 'vitest';
import releaseLazyEmojiImages from '@helpers/releaseLazyEmojiImages';

describe('releaseLazyEmojiImages', () => {
  const create = (count: number) => {
    const parent = document.createElement('span');
    const images = Array.from({length: count}, () => document.createElement('img'));
    parent.append(...images);
    return {parent, images};
  };

  test('deletes every image of the replaced content from the queue', () => {
    const {parent, images} = create(2);
    const queue = {delete: vi.fn()};

    releaseLazyEmojiImages(parent, queue);

    expect(queue.delete.mock.calls.map(([item]) => item.div)).toEqual(images);
  });

  test('keeps the image that stays', () => {
    const {parent, images} = create(3);
    const queue = {delete: vi.fn()};

    releaseLazyEmojiImages(parent, queue, images[0]);

    expect(queue.delete.mock.calls.map(([item]) => item.div)).toEqual([images[1], images[2]]);
  });

  test('does nothing without a queue', () => {
    const {parent} = create(1);

    expect(() => releaseLazyEmojiImages(parent, undefined)).not.toThrow();
  });
});
