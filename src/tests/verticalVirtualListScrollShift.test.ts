import {expect, test, vi} from 'vitest';
import {applyScrollShift} from '@components/verticalVirtualList';

test('avoids reading or writing scroll position for a zero shift', () => {
  const read = vi.fn(() => 200);
  const write = vi.fn();
  const host = Object.defineProperty({}, 'scrollTop', {get: read, set: write}) as HTMLElement;

  applyScrollShift(host, 0);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();

  applyScrollShift(host, -20);
  expect(read).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledExactlyOnceWith(220);
});
