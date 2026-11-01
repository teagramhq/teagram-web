import type {Locator, Page} from '@playwright/test';

export type FirstBubbleBoundary = {
  ms: number,
  startedAtMs: number,
  domNodes: number,
  preInteractionMs?: number
};

export async function startMeasurementAtClick(target: Locator) {
  await target.evaluate((element) => {
    const perf = (window as any).__teagramPerf as {
      started: number,
      preInteractionMs?: number,
      clickAt?: number,
      firstBubbleBoundary?: FirstBubbleBoundary,
      firstBubblePromise?: Promise<FirstBubbleBoundary>
    };
    const armedAt = performance.now();
    const onClick = (event: MouseEvent) => {
      if(!event.composedPath().includes(element)) return;
      document.removeEventListener('click', onClick, true);
      const clickAt = performance.now();
      perf.started = clickAt;
      perf.preInteractionMs = clickAt - armedAt;
      perf.clickAt = clickAt;

      const peerId = (element as HTMLElement).dataset.peerId;
      let resolveFirstBubble!: (boundary: FirstBubbleBoundary) => void;
      perf.firstBubblePromise = new Promise((resolve) => {
        resolveFirstBubble = resolve;
      });
      const checkForBubble = () => {
        const bubbles = document.querySelectorAll<HTMLElement>('.bubbles .bubble[data-mid]');
        for(const bubble of bubbles) {
          if(peerId && bubble.dataset.peerId !== peerId) continue;

          const style = getComputedStyle(bubble);
          const rect = bubble.getBoundingClientRect();
          if(style.display === 'none' || style.visibility === 'hidden' || !rect.width || !rect.height) continue;

          const boundary = {
            ms: performance.now() - clickAt,
            startedAtMs: clickAt,
            domNodes: document.querySelectorAll('*').length,
            preInteractionMs: perf.preInteractionMs
          };
          perf.firstBubbleBoundary = boundary;
          observer.disconnect();
          resolveFirstBubble(boundary);
          return;
        }
      };
      const observer = new MutationObserver(checkForBubble);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'hidden', 'style'],
        childList: true,
        subtree: true
      });
      checkForBubble();
    };
    document.addEventListener('click', onClick, true);
  });
}

export async function waitForFirstVisibleBubble(page: Page) {
  await page.waitForFunction(() => !!(window as any).__teagramPerf?.firstBubbleBoundary, undefined, {timeout: 60_000});
  return page.evaluate(async() => {
    const perf = (window as any).__teagramPerf;
    if(!perf.firstBubblePromise) {
      throw new Error('chat-open measurement was not armed for the first bubble');
    }
    return perf.firstBubblePromise as Promise<FirstBubbleBoundary>;
  });
}
