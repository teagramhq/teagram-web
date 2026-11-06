type MessageSpan = {type: string, startTime: number, duration: number, endTime?: number, messageCount?: number};
type BatchSpan = {startTime: number, endTime: number, size: number};

// Consecutive messages of the same type in one batch share a span to avoid per-message allocations.
export function installWorkerMessageAttribution(port: any, now: () => number) {
  const spans: MessageSpan[] = [];
  const batches: BatchSpan[] = [];
  const originals: Record<string, any> = {};
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
  let depth = 0;
  const swap = (useOriginals: boolean) => {
    for(const type of Object.keys(originals)) if(type !== 'batch') port.processTaskMap[type] = useOriginals ? originals[type] : wrappers[type];
  };
  for(const type of Object.keys(port.processTaskMap)) {
    const original = originals[type] = port.processTaskMap[type];
    if(type === 'batch') {
      // The batch handler only forwards each child to `port.onMessage`, so the recorder runs that loop itself and
      // classifies children inline. Per-child handler wrappers would sit in the hot dispatch path (their indirection
      // alone costs about 0.5 ms per 10,000 messages); the per-type handlers are put back for the duration of the loop.
      wrappers[type] = function(task: any, source: any, event: any) {
        const startTime = now();
        const current: {name?: string, start: number, count: number} = {start: startTime, count: 0};
        if(depth++ === 0) swap(true);
        try {
          const newEvent = {data: event.data, source: event.source, currentTarget: event.currentTarget};
          const children = task.payload;
          for(let index = 0; index < children.length; ++index) {
            const child = children[index];
            let name: string;
            if(child.type === 'invoke' && lastType === 'invoke') {
              // Same invoke kind as the previous child: reuse its name without the generic classification.
              const invoke = child.payload.type;
              const inner = child.payload.payload;
              name = invoke === lastInvoke && (invoke === 'event' || invoke === 'mirror' ? inner?.name : inner?._) === lastDetail ? lastName : getName('invoke', child);
            } else name = getName(child.type, child);
            if(name !== current.name) {
              const at = now();
              if(current.count) spans.push({type: current.name!, startTime: current.start, duration: at - current.start, endTime: at, messageCount: current.count});
              current.name = name;
              current.start = at;
              current.count = 0;
            }
            ++current.count;
            newEvent.data = child;
            port.onMessage(newEvent);
          }
        } finally {
          if(--depth === 0) swap(false);
          const endTime = now();
          if(current.count) spans.push({type: current.name!, startTime: current.start, duration: endTime - current.start, endTime, messageCount: current.count});
          batches.push({startTime, endTime, size: task.payload.length});
        }
      };
      port.processTaskMap[type] = wrappers[type];
      continue;
    }
    wrappers[type] = function(task: any, source: any, event: any) {
      const name = getName(type, task);
      const started = now();
      try {
        return original(task, source, event);
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
