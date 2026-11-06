type MessageSpan = {type: string, startTime: number, duration: number, endTime?: number, messageCount?: number};
type BatchSpan = {startTime: number, endTime: number, size: number};

// Consecutive messages of the same type in one batch share a span to avoid per-message allocations.
export function installWorkerMessageAttribution(port: any, now: () => number) {
  const spans: MessageSpan[] = [];
  const batches: BatchSpan[] = [];
  const originals: Record<string, any> = {};
  let activeBatch: {name?: string, start: number, count: number} | undefined;
  let lastType: string, lastInvoke: string, lastDetail: string, lastTaskType: string, lastTaskName: string, lastTaskMethod: string, lastResult: string, lastName: string;
  const wrappers: Record<string, any> = {};
  const getName = (type: string, task: any) => {
    const payload = task.payload;
    const pending = type === 'result' || type === 'ack' ? port.awaiting[payload.taskId] : undefined;
    const invoke = type === 'invoke' ? payload.type : undefined;
    const detail = invoke === 'event' || invoke === 'mirror' ? payload.payload?.name : payload?.payload?._;
    if(type === 'invoke' && lastType === type && invoke === lastInvoke && detail === lastDetail) return lastName;
    const result = typeof payload?.result?._ === 'string' ? payload.result._ : undefined;
    if(type !== lastType || invoke !== lastInvoke || detail !== lastDetail || pending?.taskType !== lastTaskType ||
      pending?.taskName !== lastTaskName || pending?.taskMethod !== lastTaskMethod || result !== lastResult) {
      lastType = type;
      lastInvoke = invoke;
      lastDetail = detail;
      lastTaskType = pending?.taskType;
      lastTaskName = pending?.taskName;
      lastTaskMethod = pending?.taskMethod;
      lastResult = result;
      lastName = (type === 'invoke' ? [type, invoke, detail] : [type, lastTaskType, lastTaskName, lastTaskMethod, result]).filter(Boolean).join(':');
    }
    return lastName;
  };
  for(const type of Object.keys(port.processTaskMap)) {
    const original = originals[type] = port.processTaskMap[type];
    if(type === 'batch') {
      wrappers[type] = function(task: any, ...args: any[]) {
        const previousBatch = activeBatch;
        const startTime = now();
        activeBatch = {start: startTime, count: 0};
        try {
          return original.call(this, task, ...args);
        } finally {
          const endTime = now();
          if(activeBatch.count) spans.push({type: activeBatch.name!, startTime: activeBatch.start, duration: endTime - activeBatch.start, endTime, messageCount: activeBatch.count});
          batches.push({startTime, endTime, size: task.payload.length});
          activeBatch = previousBatch;
        }
      };
      port.processTaskMap[type] = wrappers[type];
      continue;
    }
    wrappers[type] = function(task: any, ...args: any[]) {
      const name = getName(type, task);
      if(activeBatch) {
        if(name !== activeBatch.name) {
          const at = now();
          if(activeBatch.count) spans.push({type: activeBatch.name!, startTime: activeBatch.start, duration: at - activeBatch.start, endTime: at, messageCount: activeBatch.count});
          activeBatch.name = name;
          activeBatch.start = at;
          activeBatch.count = 0;
        }
        ++activeBatch.count;
        return original.call(this, task, ...args);
      }
      const started = now();
      try {
        return original.call(this, task, ...args);
      } finally {
        const endTime = now();
        spans.push({type: name, startTime: started, duration: endTime - started, endTime, messageCount: 1});
      }
    };
    port.processTaskMap[type] = wrappers[type];
  }
  return {spans, batches, restore: () => {
    for(const type of Object.keys(originals)) port.processTaskMap[type] = originals[type];
  }};
}

export function summarizeWorkerMessageAttribution(tasks: Array<{startTime: number, duration: number}>, spans: MessageSpan[], windowStart = 0, batches: BatchSpan[] = []) {
  return tasks.filter(({duration}) => duration > 50).map((task) => {
    const byType = new Map<string, number>();
    let messageCount = 0;
    const taskEnd = task.startTime + task.duration;
    const overlap = (start: number, end: number) => Math.max(0, Math.min(taskEnd, end) - Math.max(task.startTime, start));
    const intersects = (start: number, end: number) =>
      (start >= task.startTime && start < taskEnd) || overlap(start, end) > 0;
    for(const span of spans) {
      const spanEnd = span.endTime ?? span.startTime + span.duration;
      if(!intersects(span.startTime, spanEnd)) continue;
      messageCount += span.messageCount ?? 1;
      const wallTime = spanEnd - span.startTime;
      const duration = wallTime > 0 ? span.duration * overlap(span.startTime, spanEnd) / wallTime : 0;
      if(duration > 0) byType.set(span.type, (byType.get(span.type) || 0) + duration);
    }
    return {
      startTimeMs: Number((task.startTime - windowStart).toFixed(2)),
      durationMs: task.duration,
      messageCount,
      batchSizes: batches.filter(({startTime, endTime}) => intersects(startTime, endTime)).map(({size}) => size),
      unaccountedMs: Number(Math.max(0, task.duration - [...byType.values()].reduce((total, value) => total + value, 0)).toFixed(2)),
      messages: [...byType].map(([type, durationMs]) => ({
        type,
        durationMs: Number(durationMs.toFixed(2)),
        percent: Number((durationMs * 100 / task.duration).toFixed(2))
      }))
    };
  });
}
