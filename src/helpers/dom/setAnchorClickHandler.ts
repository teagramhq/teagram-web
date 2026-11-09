// Binds a window-level click handler by name without an inline `onclick` attribute (blocked by the
// content security policy). The name is mirrored in `data-click-handler` for code that needs to
// inspect it. A missing name leaves the anchor unbound. Assigning `onclick` replaces an earlier binding; set `onclick = null` to remove one.
export default function setAnchorClickHandler(element: HTMLElement, handlerName?: string) {
  if(!handlerName) return;

  element.dataset.clickHandler = handlerName;
  element.onclick = (event) => (window as any)[handlerName](element, event);
}
