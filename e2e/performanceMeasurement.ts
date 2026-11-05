import type {Locator, Page} from '@playwright/test';

export type DomNodeCounts = {
  bubbles: number,
  bubbleGroups: number,
  dateGroups: number,
  groupAvatars: number,
  deletePlaceholders: number
};

export type FirstBubbleBoundary = {
  ms: number,
  startedAtMs: number,
  domNodes: number,
  domNodeCounts: DomNodeCounts,
  preInteractionMs?: number
};

export async function startMeasurementAtClick(target: Locator) {
  await target.evaluate((element) => {
    const perf = (window as any).__teagramPerf as {
      started: number,
      preInteractionMs?: number,
      clickAt?: number,
      peerId?: string,
      firstBubbleBoundary?: FirstBubbleBoundary
    };
    const armedAt = performance.now();
    perf.peerId = (element as HTMLElement).dataset.peerId;
    const onClick = (event: MouseEvent) => {
      const peerRow = event.composedPath().find((target) =>
        target instanceof HTMLElement && target.classList.contains('chatlist-chat')
      ) as HTMLElement | undefined;
      if(perf.peerId ? peerRow?.dataset.peerId !== perf.peerId : !event.composedPath().includes(element)) return;
      document.removeEventListener('click', onClick, true);
      const clickAt = performance.now();
      perf.started = clickAt;
      perf.preInteractionMs = clickAt - armedAt;
      perf.clickAt = clickAt;
      perf.firstBubbleBoundary = undefined;
    };
    document.addEventListener('click', onClick, true);
  });
}

export async function waitForFirstVisibleBubble(page: Page) {
  await page.waitForFunction(() => {
    const perf = (window as any).__teagramPerf;
    if(!Number.isFinite(perf?.clickAt)) return false;

    const bubbles = document.querySelectorAll<HTMLElement>('.bubbles .bubble[data-mid]');
    for(const bubble of bubbles) {
      if(perf.peerId && bubble.dataset.peerId !== perf.peerId) continue;

      const style = getComputedStyle(bubble);
      const rect = bubble.getBoundingClientRect();
      if(style.display === 'none' || style.visibility === 'hidden' || !rect.width || !rect.height) continue;

      perf.firstBubbleBoundary = {
        ms: performance.now() - perf.clickAt,
        startedAtMs: perf.clickAt,
        domNodes: document.querySelectorAll('*').length,
        domNodeCounts: {
          bubbles: document.querySelectorAll('.bubbles .bubble[data-mid]').length,
          bubbleGroups: document.querySelectorAll('.bubbles .bubbles-group').length,
          dateGroups: document.querySelectorAll('.bubbles .bubbles-date-group').length,
          groupAvatars: document.querySelectorAll('.bubbles .bubbles-group-avatar-container').length,
          deletePlaceholders: document.querySelectorAll('.bubbles .bubble-delete-placeholder').length
        },
        preInteractionMs: perf.preInteractionMs
      };
      return true;
    }
    return false;
  }, undefined, {timeout: 60_000});
  return page.evaluate(() => (window as any).__teagramPerf.firstBubbleBoundary as FirstBubbleBoundary);
}
