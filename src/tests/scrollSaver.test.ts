import ScrollSaver from '@helpers/scrollSaver';

type Rect = {top: number, bottom: number};

function makeRect(top: number, bottom: number): DOMRect {
  return {x: 0, y: top, top, right: 200, bottom, left: 0, width: 200, height: bottom - top, toJSON: () => ({})};
}

const originalResizeObserver = globalThis.ResizeObserver;

function makeScrollSaver(reverse: boolean) {
  const initialScrollTop = 100;
  let scrollTop = initialScrollTop;
  let scrollHeight = 1000;
  let layoutDirty = false;
  const entries: {bubble: HTMLElement, position: Rect}[] = [];
  const container = document.createElement('div');
  const makeEntry = (position: Rect) => {
    const bubble = document.createElement('div');
    bubble.classList.add('bubble');
    const entry = {bubble, position};
    bubble.getBoundingClientRect = () => {
      requireCleanLayout();
      const {top, bottom} = entry.position;
      const scrollDelta = scrollTop - initialScrollTop;
      return makeRect(top - scrollDelta, bottom - scrollDelta);
    };
    return entry;
  };
  const bubbles = [{top: 120, bottom: 160}, {top: 240, bottom: 280}].map((position) => {
    const entry = makeEntry(position);
    entries.push(entry);
    container.append(entry.bubble);
    return entry.bubble;
  });

  const requireCleanLayout = () => {
    if(layoutDirty) throw new Error('layout read before ResizeObserver delivery');
  };

  container.getBoundingClientRect = () => {
    requireCleanLayout();
    return makeRect(100, 300);
  };

  Object.defineProperties(container, {
    scrollTop: {
      get() {
        requireCleanLayout();
        return scrollTop;
      },
      set(value: number) {
        requireCleanLayout();
        scrollTop = value;
      }
    },
    scrollHeight: {
      get() {
        requireCleanLayout();
        return scrollHeight;
      }
    },
    clientHeight: {
      get() {
        requireCleanLayout();
        return 200;
      }
    }
  });

  const scrollable = {
    container,
    get scrollPosition() {
      return container.scrollTop;
    },
    get scrollSize() {
      return container.scrollHeight;
    },
    get clientSize() {
      return container.clientHeight;
    },
    setScrollPositionSilently(value: number) {
      container.scrollTop = value;
    },
    onSizeChange: vi.fn()
  } as any;

  return {
    saver: new ScrollSaver(scrollable, '.bubble', reverse),
    bubbles,
    prependBubble(position: Rect) {
      const entry = makeEntry(position);
      entries.unshift(entry);
      container.prepend(entry.bubble);
    },
    appendBubble(position: Rect) {
      const entry = makeEntry(position);
      entries.push(entry);
      container.append(entry.bubble);
    },
    setPosition(bubble: HTMLElement, rect: Rect) {
      entries.find((entry) => entry.bubble === bubble)!.position = rect;
    },
    setScrollHeight(value: number) {
      scrollHeight = value;
    },
    setLayoutDirty(value: boolean) {
      layoutDirty = value;
    },
    getScrollTop() {
      return scrollTop;
    }
  };
}

function captureResizeObserver() {
  let callback: ResizeObserverCallback;
  class ResizeObserverMock {
    constructor(onResize: ResizeObserverCallback) {
      callback = onResize;
    }

    observe() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  return (element: Element) => callback([{target: element} as ResizeObserverEntry], {} as ResizeObserver);
}

afterEach(() => {
  vi.stubGlobal('ResizeObserver', originalResizeObserver);
  document.body.replaceChildren();
});

test('restores the top anchor after prepending history above it', async() => {
  const flushResizeObserver = captureResizeObserver();
  const {saver, prependBubble, setPosition, setScrollHeight, setLayoutDirty, getScrollTop, bubbles} = makeScrollSaver(true);
  document.body.append(bubbles[0].parentElement!);
  saver.save();

  prependBubble({top: 60, bottom: 100});
  setPosition(bubbles[0], {top: 170, bottom: 210});
  setScrollHeight(1050);
  setLayoutDirty(true);

  let restoring: Promise<void>;
  expect(() => restoring = saver.restoreAfterLayout()).not.toThrow();

  setLayoutDirty(false);
  flushResizeObserver(bubbles[0].parentElement!);
  await restoring!;

  expect(getScrollTop()).toBe(150);
  expect(bubbles[0].getBoundingClientRect().top).toBe(120);
});

test('keeps the bottom anchor still when history is appended below it', async() => {
  const flushResizeObserver = captureResizeObserver();
  const {saver, appendBubble, setScrollHeight, setLayoutDirty, getScrollTop, bubbles} = makeScrollSaver(false);
  document.body.append(bubbles[0].parentElement!);
  saver.save();

  appendBubble({top: 300, bottom: 340});
  setScrollHeight(1020);
  setLayoutDirty(true);

  let restoring: Promise<void>;
  expect(() => restoring = saver.restoreAfterLayout()).not.toThrow();

  setLayoutDirty(false);
  flushResizeObserver(bubbles[0].parentElement!);
  await restoring!;

  expect(getScrollTop()).toBe(100);
  expect(bubbles[1].getBoundingClientRect().bottom).toBe(280);
});

test('skips a pending restore after its chat generation is disposed', async() => {
  const flushResizeObserver = captureResizeObserver();
  const {saver, setPosition, setLayoutDirty, getScrollTop, bubbles} = makeScrollSaver(true);
  document.body.append(bubbles[0].parentElement!);
  saver.save();

  setPosition(bubbles[0], {top: 150, bottom: 190});
  setLayoutDirty(true);

  let restoring: Promise<void>;
  expect(() => restoring = saver.restoreAfterLayout(undefined, () => false)).not.toThrow();

  setLayoutDirty(false);
  flushResizeObserver(bubbles[0].parentElement!);
  await restoring!;

  expect(getScrollTop()).toBe(100);
});
