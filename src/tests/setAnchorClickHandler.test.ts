import {afterEach, describe, expect, it, vi} from 'vitest';
import setAnchorClickHandler from '@helpers/dom/setAnchorClickHandler';

afterEach(() => {
  vi.unstubAllGlobals();
});

function click(element: HTMLElement) {
  const event = new MouseEvent('click', {bubbles: true, cancelable: true});
  element.dispatchEvent(event);
  return event;
}

describe('anchor click handlers', () => {
  it('calls the named window handler with the element and the event without an inline attribute', () => {
    const element = document.createElement('a');
    const handler = vi.fn();
    vi.stubGlobal('im', handler);

    setAnchorClickHandler(element, 'im');
    const event = click(element);

    expect(element.getAttribute('onclick')).toBeNull();
    expect(element.dataset.clickHandler).toBe('im');
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(element, event);
  });

  it('replaces the earlier binding when the handler changes', () => {
    const element = document.createElement('a');
    const previousHandler = vi.fn();
    const nextHandler = vi.fn();
    vi.stubGlobal('im', previousHandler);
    vi.stubGlobal('showMaskedAlert', nextHandler);

    setAnchorClickHandler(element, 'im');
    setAnchorClickHandler(element, 'showMaskedAlert');
    click(element);

    expect(previousHandler).not.toHaveBeenCalled();
    expect(nextHandler).toHaveBeenCalledOnce();
    expect(element.dataset.clickHandler).toBe('showMaskedAlert');
  });

  it('leaves the anchor unbound without a handler name', () => {
    const element = document.createElement('a');

    setAnchorClickHandler(element, undefined);

    expect(element.onclick).toBeNull();
    expect(element.dataset.clickHandler).toBeUndefined();
  });

  it('stops calling the handler once onclick is cleared', () => {
    const element = document.createElement('a');
    const handler = vi.fn();
    vi.stubGlobal('im', handler);
    setAnchorClickHandler(element, 'im');

    element.onclick = null;
    click(element);

    expect(handler).not.toHaveBeenCalled();
  });
});
