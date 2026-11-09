import {afterEach, describe, expect, it, vi} from 'vitest';
import setAnchorClickHandler, * as anchorClickHandlerModule from '@helpers/dom/setAnchorClickHandler';

const anchorClickHandlerApi = anchorClickHandlerModule as unknown as {
  getAnchorClickHandler?: (element: HTMLElement) => string | undefined,
  clearAnchorClickHandler?: (element: HTMLElement) => void
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anchor click handlers', () => {
  it('reuses one listener when the handler changes', () => {
    const element = document.createElement('a');
    const previousHandler = vi.fn();
    const nextHandler = vi.fn();
    vi.stubGlobal('im', previousHandler);
    vi.stubGlobal('showMaskedAlert', nextHandler);

    setAnchorClickHandler(element, 'im');
    setAnchorClickHandler(element, 'showMaskedAlert');
    const event = new MouseEvent('click', {bubbles: true, cancelable: true});
    element.dispatchEvent(event);

    expect(previousHandler).not.toHaveBeenCalled();
    expect(nextHandler).toHaveBeenCalledOnce();
    expect(nextHandler).toHaveBeenCalledWith(element, event);
  });

  it('fails when a requested handler is not installed', () => {
    const element = document.createElement('a');

    expect(() => setAnchorClickHandler(element, 'missingHandler' as never))
    .toThrow(/missingHandler/);
    expect(anchorClickHandlerApi.getAnchorClickHandler?.(element)).toBeUndefined();
  });

  it('exposes the handler and clears it so later clicks do nothing', () => {
    const element = document.createElement('a');
    const handler = vi.fn();
    vi.stubGlobal('im', handler);
    setAnchorClickHandler(element, 'im');

    expect(anchorClickHandlerApi.getAnchorClickHandler?.(element)).toBe('im');
    expect(anchorClickHandlerApi.clearAnchorClickHandler).toBeTypeOf('function');
    anchorClickHandlerApi.clearAnchorClickHandler?.(element);
    const event = new MouseEvent('click', {bubbles: true, cancelable: true});
    element.dispatchEvent(event);

    expect(anchorClickHandlerApi.getAnchorClickHandler?.(element)).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
