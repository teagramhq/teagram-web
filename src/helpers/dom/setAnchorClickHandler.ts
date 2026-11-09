import type addAnchorListener from '@helpers/addAnchorListener';

export type AnchorClickHandlerName =
  | Parameters<typeof addAnchorListener>[0]['name']
  | 'onFormattedDateClick'
  | 'openWebPage'
  | `tg_${string}`;

type WindowWithAnchorClickHandlers = Window & Record<AnchorClickHandlerName, unknown>;

const boundElements = new WeakSet<HTMLElement>();

function getWindowHandler(handlerName: AnchorClickHandlerName) {
  return (window as unknown as WindowWithAnchorClickHandlers)[handlerName];
}

export function getAnchorClickHandler(element: HTMLElement): AnchorClickHandlerName | undefined {
  const handlerName = element.dataset.clickHandler;
  if(handlerName === undefined) return;
  if(!handlerName) throw new Error('Anchor click handler name cannot be empty');
  return handlerName as AnchorClickHandlerName;
}

export function isMaskedLinkWarningHandler(handlerName?: AnchorClickHandlerName) {
  return handlerName === 'showMaskedAlert';
}

export function clearAnchorClickHandler(element: HTMLElement) {
  delete element.dataset.clickHandler;
}

export default function setAnchorClickHandler(element: HTMLElement, handlerName: AnchorClickHandlerName) {
  if(typeof getWindowHandler(handlerName) !== 'function') {
    throw new Error(`Anchor click handler "${handlerName}" is not installed on window`);
  }

  element.dataset.clickHandler = handlerName;
  if(boundElements.has(element)) return;
  boundElements.add(element);

  element.addEventListener('click', (event) => {
    const currentHandlerName = getAnchorClickHandler(element);
    if(!currentHandlerName) return;

    const currentHandler = getWindowHandler(currentHandlerName);
    if(typeof currentHandler !== 'function') {
      event.preventDefault();
      throw new Error(`Anchor click handler "${currentHandlerName}" is not installed on window`);
    }

    currentHandler.call(window, element, event);
  });
}
