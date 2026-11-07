import type {Locator, Page} from '@playwright/test';

export async function finishIncompleteScroll(message: string, required: boolean, stopTrace?: () => Promise<unknown>) {
  if(stopTrace) {
    try {
      await stopTrace();
    } catch(error) {
      throw new Error(`${message}; frame trace cleanup failed: ${String(error)}`);
    }
  }
  if(required) throw new Error(message);
}

export async function getContactsFailureDetails(page: Page) {
  return page.evaluate(() => ({
    containerCount: document.querySelectorAll('#contacts-container').length,
    listCount: document.querySelectorAll('#contacts-container #contacts').length,
    rowCount: document.querySelectorAll('#contacts-container .chatlist-chat').length,
    searchLength: document.querySelector<HTMLInputElement>('#contacts-container .input-search-input')?.value.length ?? null
  })).catch((): null => null);
}

export async function getContactsRpcFailureDetails(page: Page) {
  return page.evaluate(async() => {
    try {
      const manager = (window as any).rootScope.managers.apiManager;
      const timeout = new Promise<{timedOut: true}>((resolve) => setTimeout(() => resolve({timedOut: true}), 2_000));
      const trace = await Promise.race([manager.getPerformanceRpcTrace(), timeout]) as
        {calls: Array<{method: string, durationMs: number | null, outcome: string}>} | {timedOut: true} | null;
      if(trace && 'calls' in trace) return trace.calls.filter((call) => call.method === 'contacts.getContacts');
      return trace ?? null;
    } catch(error) {
      return {error: String(error)};
    }
  }).catch(() => ({error: 'page unavailable'}));
}

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
  domClassCounts: Record<string, number>,
  domNodeCounts: DomNodeCounts,
  preInteractionMs?: number
};

export type FirstVisibleChatListBoundary = {
  ms: number,
  source: 'snapshot' | 'live'
};

export function observeFirstVisibleChatList() {
  const perf = (window as any).__teagramPerf;
  if(!Number.isFinite(perf?.started)) return;

  const isVisible = (row: HTMLElement | null) => {
    if(!row) return false;
    let current: HTMLElement | null = row;
    while(current) {
      const style = getComputedStyle(current);
      if(style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      current = current.parentElement;
    }
    const rect = row.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const recordFirstVisibleRow = () => {
    if(perf.firstVisibleChatListBoundary) return;
    const snapshotRow = document.querySelector<HTMLElement>('.chat-page-snapshot .chatlist-chat');
    const liveRow = document.querySelector<HTMLElement>('#page-chats #folders-container .chatlist-chat');
    const source = isVisible(snapshotRow) ? 'snapshot' : isVisible(liveRow) ? 'live' : undefined;
    if(source) {
      perf.firstVisibleChatListBoundary = {ms: performance.now() - perf.started, source};
      return;
    }
    requestAnimationFrame(recordFirstVisibleRow);
  };

  requestAnimationFrame(recordFirstVisibleRow);
}

export async function waitForFirstVisibleChatList(page: Page): Promise<FirstVisibleChatListBoundary> {
  await page.waitForFunction(() => {
    const perf = (window as any).__teagramPerf;
    return !!perf?.firstVisibleChatListBoundary;
  }, undefined, {polling: 'raf', timeout: 120_000});
  return page.evaluate(() => (window as any).__teagramPerf.firstVisibleChatListBoundary as FirstVisibleChatListBoundary);
}

export async function beginMeasurement(page: Page, requests: {value: number}, recordRpcSpans = true, traceEnabled = false, captureWorkerMessages = false) {
  requests.value = 0;
  await page.evaluate(async({recordSpans, traceEnabled, captureWorkerMessages}) => {
    if(traceEnabled) await (window as any).rootScope.managers.apiManager.resetPerformanceRpcTrace(recordSpans);
    const perf = (window as any).__teagramPerf;
    if(captureWorkerMessages) {
      perf.workerMessages = (window as any).__teagramInstallWorkerMessageAttribution((window as any).apiManagerProxy, () => performance.now());
    }
    perf.longTasks = [];
    perf.longAnimationFrames = [];
    perf.frameIntervals = [];
    perf.frameWindows = [];
    perf.resourceUrlBaseline = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((entry) => entry.name);
    performance.clearResourceTimings();
    if(traceEnabled) performance.clearMeasures();
    perf.started = performance.now();
  }, {recordSpans: recordRpcSpans, traceEnabled, captureWorkerMessages});
}

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

      const ms = performance.now() - perf.clickAt;
      const elements = [...document.querySelectorAll('*')];
      const domClassCounts: Record<string, number> = {};
      for(const element of elements) for(const name of element.classList) {
        const key = `${element.tagName.toLowerCase()}.${name}`;
        domClassCounts[key] = (domClassCounts[key] || 0) + 1;
      }
      perf.firstBubbleBoundary = {
        ms,
        startedAtMs: perf.clickAt,
        domNodes: elements.length,
        domClassCounts,
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
