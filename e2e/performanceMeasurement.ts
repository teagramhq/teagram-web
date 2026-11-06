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
  domClassCounts: Record<string, number>,
  domNodeCounts: DomNodeCounts,
  preInteractionMs?: number
};

export async function beginMeasurement(page: Page, requests: {value: number}, recordRpcSpans = true, traceEnabled = false, captureWorkerMessages = false, observeWorkerBatches = false) {
  requests.value = 0;
  await page.evaluate(async({recordSpans, traceEnabled, captureWorkerMessages, observeWorkerBatches}) => {
    if(traceEnabled) await (window as any).rootScope.managers.apiManager.resetPerformanceRpcTrace(recordSpans);
    const perf = (window as any).__teagramPerf;
    if(captureWorkerMessages) {
      perf.workerMessages = (window as any).__teagramInstallWorkerMessageAttribution((window as any).apiManagerProxy, () => performance.now());
    }
    if(observeWorkerBatches) {
      const ports = (window as any).apiManagerProxy.listenPorts as MessagePort[];
      if(!ports.length) throw new Error('Worker batch probe has no listen ports');
      const events: Array<{at: number, size: number, kind: string}> = [];
      const onMessage = (event: MessageEvent) => {
        const task = event.data;
        if(task?.type !== 'batch' || !Array.isArray(task.payload) || task.payload.length < 1000) return;
        const sample = task.payload[Math.floor(task.payload.length / 2)];
        const invoke = sample?.type === 'invoke' ? sample.payload?.type : undefined;
        const detail = invoke === 'mirror' || invoke === 'event' ? sample.payload?.payload?.name : undefined;
        events.push({at: performance.now(), size: task.payload.length, kind: [sample?.type, invoke, detail].filter(Boolean).join(':')});
      };
      for(const port of ports) port.addEventListener('message', onMessage);
      perf.workerBatchProbe = {events, stop: () => {
        for(const port of ports) port.removeEventListener('message', onMessage);
      }};
    }
    perf.longTasks = [];
    perf.longAnimationFrames = [];
    perf.frameIntervals = [];
    perf.resourceUrlBaseline = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((entry) => entry.name);
    performance.clearResourceTimings();
    if(traceEnabled) performance.clearMeasures();
    perf.started = performance.now();
  }, {recordSpans: recordRpcSpans, traceEnabled, captureWorkerMessages, observeWorkerBatches});
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
