import getVisibleRect from '@helpers/dom/getVisibleRect';

export type ViewportSlicePart = {element: HTMLElement, rect: DOMRect, visibleRect: ReturnType<typeof getVisibleRect>}[];

function createPart(element: HTMLElement, rect?: DOMRect, visibleRect: ReturnType<typeof getVisibleRect> = null) {
  if(rect) return {element, rect, visibleRect};

  return {
    element,
    get rect() {
      // Most offscreen bubbles are only used for deletion. Keep the existing exact rect contract for
      // callers that read it, but don't force a layout read for every item in a large chat history.
      return element.getBoundingClientRect();
    },
    visibleRect
  };
}

function findFirstIndex(length: number, predicate: (index: number) => boolean) {
  let start = 0;
  let end = length;
  while(start < end) {
    const middle = start + ((end - start) >> 1);
    if(predicate(middle)) end = middle;
    else start = middle + 1;
  }

  return start;
}

function getOrderedElementsSlice(
  elements: HTMLElement[],
  overflowElement: HTMLElement,
  overflowRect: DOMRectMinified,
  extraMinLength?: number
) {
  // Chat bubbles are in normal vertical document flow, in the same order as querySelectorAll. Find
  // the small range that can intersect the viewport with binary searches, then measure only that
  // range. The offscreen prefix/suffix still carry lazy rect getters for API compatibility.
  const rects = new Map<number, DOMRect>();
  const getRect = (index: number) => {
    let rect = rects.get(index);
    if(!rect) {
      rect = elements[index].getBoundingClientRect();
      rects.set(index, rect);
    }
    return rect;
  };

  const firstCandidate = findFirstIndex(elements.length, (index) => getRect(index).bottom > overflowRect.top);
  const endCandidate = findFirstIndex(elements.length, (index) => getRect(index).top >= overflowRect.bottom);
  const candidateParts = new Map<number, ReturnType<typeof createPart>>();
  let firstVisible = -1;
  for(let index = firstCandidate; index < endCandidate; ++index) {
    const element = elements[index];
    const rect = getRect(index);
    const visibleRect = getVisibleRect(element, overflowElement, false, rect, overflowRect);
    const part = createPart(element, rect, visibleRect);
    candidateParts.set(index, part);
    if(firstVisible === -1 && visibleRect) firstVisible = index;
  }

  if(firstVisible === -1) {
    return {
      invisibleTop: elements.map((element, index) => createPart(element, rects.get(index))),
      visible: [] as ReturnType<typeof createPart>[],
      invisibleBottom: [] as ReturnType<typeof createPart>[]
    };
  }

  const invisibleTop = elements.slice(0, firstVisible).map((element, index) => createPart(element, rects.get(index)));
  const visible: ReturnType<typeof createPart>[] = [];
  const invisibleBottom: ReturnType<typeof createPart>[] = [];
  for(let index = firstVisible; index < elements.length; ++index) {
    const part = candidateParts.get(index) ?? createPart(elements[index], rects.get(index));
    if(part.visibleRect) visible.push(part);
    else if(index > firstVisible) invisibleBottom.push(part);
  }

  if(extraMinLength) {
    visible.unshift(...invisibleTop.splice(Math.max(0, invisibleTop.length - extraMinLength), extraMinLength));
    visible.push(...invisibleBottom.splice(0, extraMinLength));
  }

  return {invisibleTop, visible, invisibleBottom};
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
  overflowRect ??= overflowElement.getBoundingClientRect();
  const useOrderedDomElements = elements === undefined;
  elements ??= Array.from(overflowElement.querySelectorAll<HTMLElement>(selector));

  if(extraSize) {
    overflowRect = {
      top: overflowRect.top - extraSize,
      right: overflowRect.right + extraSize,
      bottom: overflowRect.bottom + extraSize,
      left: overflowRect.left - extraSize
    };
  }

  if(useOrderedDomElements) {
    return getOrderedElementsSlice(elements, overflowElement, overflowRect, extraMinLength);
  }

  const invisibleTop: ViewportSlicePart = [],
    visible: typeof invisibleTop = [],
    invisibleBottom: typeof invisibleTop = [];
  let foundVisible = false;
  for(const element of elements) {
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

  if(extraMinLength) {
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
