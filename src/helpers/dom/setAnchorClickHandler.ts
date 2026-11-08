export default function setAnchorClickHandler(element: HTMLElement, handlerName: string) {
  element.dataset.clickHandler = handlerName;
  element.addEventListener('click', (event) => {
    const currentHandler = element.dataset.clickHandler;
    if(currentHandler) (window as any)[currentHandler](element, event);
  });
}
