import getVisibleRect from '@helpers/dom/getVisibleRect';

export type ViewportSlicePart = {element: HTMLElement, rect: DOMRect, visibleRect: ReturnType<typeof getVisibleRect>}[];

function createPart(element: HTMLElement, rect?: DOMRect, visibleRect: ReturnType<typeof getVisibleRect> = null) {
  return rect ? {element, rect, visibleRect} : {
    element,
    get rect() {
      return element.getBoundingClientRect();
    },
    visibleRect
  };
}

function findOrderedIndex(elements: HTMLElement[], key: 'top' | 'bottom', boundary: number, inclusive: boolean) {
  let low = 0;
  let high = elements.length;
  while(low < high) {
    const middle = (low + high) >> 1;
    const value = elements[middle].getBoundingClientRect()[key];
    if(inclusive ? value >= boundary : value > boundary) high = middle;
    else low = middle + 1;
  }
  return low;
}

export default function getViewportSlice({
  overflowElement,
  overflowRect,
  selector,
  extraSize,
  extraMinLength,
  elements
}: {
  overflowElement: HTMLElement,
  overflowRect?: DOMRectMinified,
  extraSize?: number,
  extraMinLength?: number,
  selector?: string,
  elements?: HTMLElement[]
}) {
  // const perf = performance.now();
  const ordered = !elements;
  overflowRect ??= overflowElement.getBoundingClientRect();
  elements ??= Array.from(overflowElement.querySelectorAll<HTMLElement>(selector));

  if(extraSize) {
    overflowRect = {
      top: overflowRect.top - extraSize,
      right: overflowRect.right + extraSize,
      bottom: overflowRect.bottom + extraSize,
      left: overflowRect.left - extraSize
    };
  }

  const invisibleTop: ViewportSlicePart = [],
    visible: typeof invisibleTop = [],
    invisibleBottom: typeof invisibleTop = [];
  const first = ordered ? findOrderedIndex(elements, 'bottom', overflowRect.top, false) : 0;
  const end = ordered ? findOrderedIndex(elements, 'top', overflowRect.bottom, true) : elements.length;
  invisibleTop.push(...elements.slice(0, first).map((element) => createPart(element)));
  let foundVisible = false;
  for(let index = first; index < end; ++index) {
    const element = elements[index];
    const rect = element.getBoundingClientRect();
    const visibleRect = getVisibleRect(element, overflowElement, false, rect, overflowRect);

    const isVisible = !!visibleRect;
    let array: typeof invisibleTop;
    if(isVisible) {
      foundVisible = true;
      array = visible;
    } else if(foundVisible) {
      array = invisibleBottom;
    } else {
      array = invisibleTop;
    }

    array.push(createPart(element, rect, visibleRect));
  }

  if(ordered) {
    invisibleBottom.push(...elements.slice(end).map((element) => createPart(element)));
    if(!foundVisible) {
      invisibleTop.push(...invisibleBottom);
      invisibleBottom.length = 0;
    }
  }

  if(extraMinLength && (foundVisible || !ordered)) {
    visible.unshift(...invisibleTop.splice(Math.max(0, invisibleTop.length - extraMinLength), extraMinLength));
    visible.push(...invisibleBottom.splice(0, extraMinLength));
  }

  // if(extraSize && visible.length) {
  //   const maxTop = visible[0].rect.top;
  //   const minTop = maxTop - extraSize;
  //   const minBottom = visible[visible.length - 1].rect.bottom;
  //   const maxBottom = minBottom + extraSize;

  //   for(let length = invisibleTop.length, i = length - 1; i >= 0; --i) {
  //     const element = invisibleTop[i];
  //     if(element.rect.top >= minTop) {
  //       invisibleTop.splice(i, 1);
  //       visible.unshift(element);
  //     }
  //   }

  //   for(let i = 0, length = invisibleBottom.length; i < length; ++i) {
  //     const element = invisibleBottom[i];
  //     if(element.rect.bottom <= maxBottom) {
  //       invisibleBottom.splice(i--, 1);
  //       --length;
  //       visible.push(element);
  //     }
  //   }
  // }

  // console.log('getViewportSlice time:', performance.now() - perf);

  return {invisibleTop, visible, invisibleBottom};
}
