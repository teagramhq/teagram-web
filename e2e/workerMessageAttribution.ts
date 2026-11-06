type MessageSpan = {
  type: string,
  startTime: number,
  duration: number,
  recorderStart?: number,
  recorderEnd?: number
};
type BatchSpan = {startTime: number, endTime: number, size: number};

// Installed only on the measured page. Keep the original handlers and their return values intact.
export function installWorkerMessageAttribution(port: any, now: () => number) {
  const spans: MessageSpan[] = [];
  const batches: BatchSpan[] = [];
  const originals: Record<string, any> = {};
  for(const type of Object.keys(port.processTaskMap)) {
    const original = originals[type] = port.processTaskMap[type];
    if(type === 'batch') {
      port.processTaskMap[type] = function(task: any, ...args: any[]) {
        const startTime = now();
        try {
          return original.call(this, task, ...args);
        } finally {
          batches.push({startTime, endTime: now(), size: task.payload.length});
        }
      };
      continue;
    }
    port.processTaskMap[type] = function(task: any, ...args: any[]) {
      const recorderStart = now();
      const payload = task.payload;
      const pending = type === 'result' || type === 'ack' ? port.awaiting[payload.taskId] : undefined;
      const invokeKind = payload?.type === 'event' || payload?.type === 'mirror' ? payload.payload?.name : payload?.payload?._;
      const resultKind = typeof payload?.result?._ === 'string' ? payload.result._ : undefined;
      const name = type === 'invoke' ?
        [type, payload.type, invokeKind] :
        [type, pending?.taskType, pending?.taskName, pending?.taskMethod, resultKind];
      const started = now();
      try {
        return original.call(this, task, ...args);
      } finally {
        const duration = now() - started;
        const span: MessageSpan = {type: name.filter(Boolean).join(':'), startTime: started, duration, recorderStart};
        spans.push(span);
        span.recorderEnd = now();
      }
    };
  }
  return {spans, batches, restore: () => {
    for(const type of Object.keys(originals)) port.processTaskMap[type] = originals[type];
  }};
}

export function summarizeWorkerMessageAttribution(tasks: Array<{startTime: number, duration: number}>, spans: MessageSpan[], windowStart = 0, batches: BatchSpan[] = []) {
  return tasks.filter(({duration}) => duration > 50).map((task) => {
    const byType = new Map<string, number>();
    let recorderOverheadMs = 0;
    let messageCount = 0;
    const taskEnd = task.startTime + task.duration;
    const overlap = (start: number, end: number) => Math.max(0, Math.min(taskEnd, end) - Math.max(task.startTime, start));
    const intersects = (start: number, end: number) =>
      (start >= task.startTime && start < taskEnd) || overlap(start, end) > 0;
    for(const span of spans) {
      const duration = overlap(span.startTime, span.startTime + span.duration);
      if(!intersects(span.recorderStart ?? span.startTime, span.recorderEnd ?? span.startTime + span.duration)) continue;
      ++messageCount;
      if(duration > 0) byType.set(span.type, (byType.get(span.type) || 0) + duration);
      if(span.recorderStart !== undefined && span.recorderEnd !== undefined) {
        recorderOverheadMs += overlap(span.recorderStart, span.startTime);
        recorderOverheadMs += overlap(span.startTime + span.duration, span.recorderEnd);
      }
    }
    return {
      startTimeMs: Number((task.startTime - windowStart).toFixed(2)),
      durationMs: task.duration,
      messageCount,
      batchSizes: batches.filter(({startTime, endTime}) => intersects(startTime, endTime)).map(({size}) => size),
      // This excludes the batch wrapper, clock resolution and any later GC caused by allocations.
      recorderOverheadMs: Number(recorderOverheadMs.toFixed(2)),
      // Long-task durations may be rounded, so retain a 1 ms margin around the threshold.
      measuredOverheadCouldCross50Ms: recorderOverheadMs > 0 && task.duration - recorderOverheadMs < 51,
      unaccountedMs: Number(Math.max(0, task.duration - [...byType.values()].reduce((total, value) => total + value, 0)).toFixed(2)),
      messages: [...byType].map(([type, durationMs]) => ({
        type,
        durationMs: Number(durationMs.toFixed(2)),
        percent: Number((durationMs * 100 / task.duration).toFixed(2))
      }))
    };
  });
}
