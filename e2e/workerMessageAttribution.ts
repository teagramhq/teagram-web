type MessageSpan = {type: string, startTime: number, duration: number};

// Installed only on the measured page. Keep the original handlers and their return values intact.
export function installWorkerMessageAttribution(port: any, now: () => number) {
  const spans: MessageSpan[] = [];
  const originals: Record<string, any> = {};
  for(const type of Object.keys(port.processTaskMap)) {
    if(type === 'batch') continue;
    const original = originals[type] = port.processTaskMap[type];
    port.processTaskMap[type] = function(task: any, ...args: any[]) {
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
        spans.push({type: name.filter(Boolean).join(':'), startTime: started, duration: now() - started});
      }
    };
  }
  return {spans, restore: () => {
    for(const type of Object.keys(originals)) port.processTaskMap[type] = originals[type];
  }};
}

export function summarizeWorkerMessageAttribution(tasks: Array<{startTime: number, duration: number}>, spans: MessageSpan[], windowStart = 0) {
  return tasks.filter(({duration}) => duration > 50).map((task) => {
    const byType = new Map<string, number>();
    for(const span of spans) {
      const overlap = Math.min(task.startTime + task.duration, span.startTime + span.duration) - Math.max(task.startTime, span.startTime);
      if(overlap > 0) byType.set(span.type, (byType.get(span.type) || 0) + overlap);
    }
    return {
      startTimeMs: Number((task.startTime - windowStart).toFixed(2)),
      durationMs: task.duration,
      messages: [...byType].map(([type, durationMs]) => ({
        type,
        durationMs: Number(durationMs.toFixed(2)),
        percent: Number((durationMs * 100 / task.duration).toFixed(2))
      }))
    };
  });
}
