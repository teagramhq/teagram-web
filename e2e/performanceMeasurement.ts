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
  rpcStartedAtMs?: number,
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

export async function waitForPartnerDialogHistoryPrefetch(page: Page, peerId: number, includeQueued = true) {
  await page.waitForFunction(({peerId, includeQueued}) => {
    const queue = (window as any).appDialogsManager?.lazyLoadQueue;
    if(!Array.isArray(queue?.queue) || !(queue?.inProcess instanceof Set)) {
      throw new Error('chat-list history lazy-load queue is unavailable');
    }
    const rows = [...document.querySelectorAll<HTMLElement>(`#chatlist-container .chatlist-chat[data-peer-id="${peerId}"]`)];
    if(!rows.length) throw new Error(`fixture peer ${peerId} has no chat-list row before the cold history flush`);
    // An in-flight item can outlive its row when dialog reconciliation replaces the DOM node.
    return ![...(includeQueued ? queue.queue : []), ...queue.inProcess].some((item) => item.div?.dataset.peerId === String(peerId));
  }, {peerId, includeQueued}, {timeout: 60_000, polling: 20});
}

export async function waitForDialogHistoryPrefetches(page: Page) {
  await page.waitForFunction(() => {
    const queue = (window as any).appDialogsManager?.lazyLoadQueue;
    if(!queue?.lockPromise || !(queue.inProcess instanceof Set)) {
      throw new Error('chat-list history lazy-load queue must be locked while draining prefetches');
    }
    return queue.inProcess.size === 0;
  }, undefined, {timeout: 60_000, polling: 20});
}

export async function withLockedDialogHistoryPrefetch<T>(page: Page, action: () => Promise<T>): Promise<T> {
  await page.evaluate(() => {
    const queue = (window as any).appDialogsManager?.lazyLoadQueue;
    if(typeof queue?.lock !== 'function' || typeof queue?.unlockAndRefresh !== 'function') {
      throw new Error('chat-list history lazy-load queue cannot be locked');
    }
    queue.lock();
    if(!queue.lockPromise) throw new Error('chat-list history prefetch could not be locked');
  });
  let actionFailed = false;
  let actionError: unknown;
  try {
    return await action();
  } catch(error) {
    actionFailed = true;
    actionError = error;
    throw error;
  } finally {
    try {
      await page.evaluate(() => {
        const queue = (window as any).appDialogsManager.lazyLoadQueue;
        if(queue.lockPromise) queue.unlockAndRefresh();
      });
    } catch(error) {
      if(actionFailed) throw Object.assign(new Error('chat-open and prefetch cleanup failed'), {errors: [actionError, error]});
      throw error;
    }
  }
}

export async function startMeasurementAtClick(target: Locator, captureMouseDown = false, releasePrefetchAtMouseDown = false) {
  await target.evaluate((element, {captureMouseDown, releasePrefetchAtMouseDown}) => {
    const queue = (window as any).appDialogsManager?.lazyLoadQueue;
    if(releasePrefetchAtMouseDown && (!captureMouseDown || !queue?.lockPromise || typeof queue.unlockAndRefresh !== 'function')) {
      throw new Error('chat-list history prefetch must be locked before arming its mousedown release');
    }
    const perf = (window as any).__teagramPerf as {
      started: number,
      preInteractionMs?: number,
      clickAt?: number,
      rpcStartedAtMs?: number,
      prefetchReleasedAtMouseDown?: boolean,
      peerId?: string,
      firstBubbleBoundary?: FirstBubbleBoundary
    };
    const armedAt = performance.now();
    perf.peerId = (element as HTMLElement).dataset.peerId;
    perf.rpcStartedAtMs = undefined;
    perf.prefetchReleasedAtMouseDown = false;
    const matchesTarget = (event: MouseEvent) => {
      const peerRow = event.composedPath().find((target) =>
        target instanceof HTMLElement && target.classList.contains('chatlist-chat')
      ) as HTMLElement | undefined;
      return perf.peerId ? peerRow?.dataset.peerId === perf.peerId : event.composedPath().includes(element);
    };
    const onMouseDown = (event: MouseEvent) => {
      if(event.button !== 0 || !matchesTarget(event)) return;
      perf.rpcStartedAtMs = performance.now();
      document.removeEventListener('mousedown', onMouseDown, true);
      if(releasePrefetchAtMouseDown && (window as any).appDialogsManager?.lazyLoadQueue === queue && queue.lockPromise) {
        queue.unlockAndRefresh();
        perf.prefetchReleasedAtMouseDown = true;
      }
    };
    const onClick = (event: MouseEvent) => {
      if(!matchesTarget(event)) return;
      document.removeEventListener('click', onClick, true);
      if(captureMouseDown) document.removeEventListener('mousedown', onMouseDown, true);
      const clickAt = performance.now();
      perf.started = clickAt;
      perf.preInteractionMs = clickAt - armedAt;
      perf.clickAt = clickAt;
      perf.firstBubbleBoundary = undefined;
    };
    if(captureMouseDown) document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('click', onClick, true);
  }, {captureMouseDown, releasePrefetchAtMouseDown});
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
        rpcStartedAtMs: perf.rpcStartedAtMs,
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
