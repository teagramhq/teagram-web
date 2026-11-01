import {describe, expect, it, vi} from 'vitest';
import {resolveSearchHelperResults} from '@components/sidebarLeft/searchHelperResults';

describe('resolveSearchHelperResults', () => {
  it('discards async results after the helper middleware is cleaned', () => {
    const middleware = vi.fn(() => false);

    expect(resolveSearchHelperResults([undefined], middleware)).toBeUndefined();
    expect(middleware).toHaveBeenCalledOnce();
  });

  it('flattens current results while skipping canceled branches', () => {
    expect(resolveSearchHelperResults([['date'], undefined, ['contact']], () => true)).toEqual([
      'date',
      'contact'
    ]);
  });
});
