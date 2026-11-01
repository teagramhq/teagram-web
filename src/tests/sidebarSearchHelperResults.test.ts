import {describe, expect, it, vi} from 'vitest';
import {updateSearchHelperResults} from '@components/sidebarLeft/searchHelperResults';

describe('updateSearchHelperResults', () => {
  it('leaves existing results untouched after the helper middleware is cleaned', () => {
    const helper = document.createElement('div');
    const existingResult = document.createElement('span');
    helper.append(existingResult);
    const middleware = vi.fn(() => false);
    const appendToHelper = vi.fn();

    updateSearchHelperResults([['stale']], middleware, helper, appendToHelper);

    expect(helper.childNodes.length).toBe(1);
    expect(helper.firstChild).toBe(existingResult);
    expect(middleware).toHaveBeenCalledOnce();
    expect(appendToHelper).not.toHaveBeenCalled();
  });

  it('replaces results with flattened data for the current search', () => {
    const helper = document.createElement('div');
    const staleResult = document.createElement('span');
    helper.append(staleResult);
    const appendToHelper = vi.fn();

    updateSearchHelperResults([['date'], ['contact']], () => true, helper, appendToHelper);

    expect(helper.childNodes.length).toBe(0);
    expect(appendToHelper).toHaveBeenCalledWith(['date', 'contact']);
  });
});
