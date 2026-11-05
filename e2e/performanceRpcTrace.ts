export type PerformanceRpcCall = {
  method: string,
  startedAtMs: number,
  durationMs: number | null,
  outcome: 'pending' | 'success' | 'error'
};

export type PerformanceRpcSummary = {
  rpcCallCount: number,
  rpcWallMs: number,
  nonRpcElapsedMs: number,
  rpcCalls: PerformanceRpcCall[]
};

export type PerformanceCpuProfile = {
  nodes: Array<{
    id: number,
    callFrame: {functionName?: string, url?: string},
    children?: number[]
  }>,
  samples?: number[],
  timeDeltas?: number[]
};

export type PerformanceSpan = {
  name: string,
  startMs: number,
  syncMs: number
};

export type PerformanceTaskAttribution = {
  startTimeMs: number,
  durationMs: number,
  spans: Array<{name: string, startOffsetMs: number, syncMs: number}>,
  stacks: Array<{frames: Array<{functionName: string, script: string}>, selfMs: number}>
};

type LongAnimationFrameScript = {
  sourceURL?: string,
  sourceFunctionName?: string,
  invoker?: string,
  invokerType?: string,
  executionStart: number,
  duration: number,
  forcedStyleAndLayoutDuration?: number
};

type LongAnimationFrame = {
  startTime: number,
  duration: number,
  scripts: LongAnimationFrameScript[]
};

export type PerformanceCpuSummary = {
  sampledCpuMs: number,
  topFrames: Array<{functionName: string, script: string, selfMs: number}>,
  topStacks: Array<{frames: Array<{functionName: string, script: string}>, selfMs: number}>
};

export type PerformancePhaseSummary = {
  name: string,
  durationMs: number | null,
  accountNumber?: number,
  pageCount?: number,
  startMs?: number
};

export type CachedDialogReconcileSummary = {
  pageCount: number | null,
  startRelativeToScenarioMs: number,
  endRelativeToScenarioMs: number | null,
  mainThreadTimeMs: number
};

export function summarizeLongTaskWindow(entries: Array<{startTime: number, duration: number}>, startedAtMs: number, elapsedMs: number) {
  const endAtMs = startedAtMs + elapsedMs;
  const tasks = entries.filter(({startTime, duration}) => startTime >= startedAtMs && startTime < endAtMs && duration > 50);
  return {
    longTasksOver50Ms: tasks.length,
    blockingTimeMs: tasks.reduce((total, {duration}) => total + duration - 50, 0),
    maxLongTaskDurationMs: tasks.reduce((max, {duration}) => Math.max(max, duration), 0)
  };
}

export function summarizeLongTaskTrace(
  entries: Array<{startTime: number, duration: number}>,
  frames: LongAnimationFrame[],
  startedAtMs: number,
  elapsedMs: number
) {
  const endAtMs = startedAtMs + elapsedMs;
  const round = (value: number) => Number(value.toFixed(2));
  return entries.filter(({startTime, duration}) => startTime >= startedAtMs && startTime < endAtMs && duration > 50).map((task) => ({
    startTimeMs: round(task.startTime - startedAtMs),
    durationMs: round(task.duration),
    scripts: frames.flatMap((frame) => {
      const frameEnd = frame.startTime + frame.duration;
      if(frame.startTime >= task.startTime + task.duration || frameEnd <= task.startTime) {
        return [];
      }

      return frame.scripts.filter((script) => {
        const scriptEnd = script.executionStart + script.duration;
        return script.executionStart < task.startTime + task.duration && scriptEnd > task.startTime;
      }).map((script) => ({
        functionName: script.sourceFunctionName || '(anonymous)',
        script: script.sourceURL ? new URL(script.sourceURL, 'https://trace.invalid').pathname : '/native',
        invoker: script.invoker || '',
        invokerType: script.invokerType || '',
        durationMs: round(script.duration),
        forcedStyleAndLayoutDurationMs: round(script.forcedStyleAndLayoutDuration || 0)
      }));
    })
  }));
}

export function summarizePerformancePhases<T extends {name: string, durationMs: number | null, accountNumber?: number, pageCount?: number, startMs?: number}>(phases: T[]): PerformancePhaseSummary[] {
  return phases.map(({name, durationMs, accountNumber, pageCount, startMs}) => ({
    name,
    durationMs: Number.isFinite(durationMs) ? Number(durationMs!.toFixed(2)) : null,
    ...(accountNumber === undefined ? {} : {accountNumber}),
    ...(pageCount === undefined ? {} : {pageCount}),
    ...(startMs === undefined ? {} : {startMs: Number(startMs.toFixed(2))})
  }));
}

export function summarizeCachedDialogReconcile(
  phase: {pageCount?: number, startedAtEpochMs: number, durationMs: number | null},
  scenarioStartedAtEpochMs: number,
  mainThreadTimeMs: number
): CachedDialogReconcileSummary {
  const startRelativeToScenarioMs = phase.startedAtEpochMs - scenarioStartedAtEpochMs;
  return {
    pageCount: phase.pageCount ?? null,
    startRelativeToScenarioMs: Number(startRelativeToScenarioMs.toFixed(2)),
    endRelativeToScenarioMs: phase.durationMs === null ? null : Number((startRelativeToScenarioMs + phase.durationMs).toFixed(2)),
    mainThreadTimeMs: Number(mainThreadTimeMs.toFixed(2))
  };
}

export function summarizeRpcTrace(rpcCalls: PerformanceRpcCall[], elapsedMs: number): PerformanceRpcSummary {
  const intervals = rpcCalls.map(({startedAtMs, durationMs}) => {
    const start = Math.max(0, Math.min(elapsedMs, startedAtMs));
    const end = Math.min(elapsedMs, start + (Number.isFinite(durationMs) ? Math.max(0, durationMs!) : elapsedMs - start));
    return {start, end};
  }).filter(({end, start}) => end > start).sort((left, right) => left.start - right.start);

  let rpcWallMs = 0;
  let intervalStart = -1;
  let intervalEnd = -1;
  for(const interval of intervals) {
    if(interval.start > intervalEnd) {
      rpcWallMs += intervalEnd - intervalStart;
      intervalStart = interval.start;
      intervalEnd = interval.end;
    } else {
      intervalEnd = Math.max(intervalEnd, interval.end);
    }
  }
  rpcWallMs += intervalEnd - intervalStart;

  return {
    rpcCallCount: rpcCalls.length,
    rpcWallMs: Math.max(0, rpcWallMs),
    nonRpcElapsedMs: Math.max(0, elapsedMs - rpcWallMs),
    rpcCalls
  };
}

export function summarizeCpuProfile(profile: PerformanceCpuProfile): PerformanceCpuSummary {
  const callFrames = new Map(profile.nodes.map(({id, callFrame}) => [id, callFrame]));
  const parentIds = new Map<number, number>();
  profile.nodes.forEach(({id, children = []}) => {
    children.forEach((childId) => parentIds.set(childId, id));
  });
  const selfTimeByFrame = new Map<string, {functionName: string, script: string, selfMs: number}>();
  const selfTimeByStack = new Map<string, {frames: Array<{functionName: string, script: string}>, selfMs: number}>();
  let sampledCpuMs = 0;

  (profile.samples || []).forEach((nodeId, index) => {
    const selfMs = Math.max(0, profile.timeDeltas?.[index] || 0) / 1000;
    if(!selfMs) return;

    const callFrame = callFrames.get(nodeId);
    const functionName = callFrame?.functionName || '(anonymous)';
    const path = callFrame?.url ? new URL(callFrame.url, 'https://trace.invalid').pathname : '';
    const script = path ? path.split('/').slice(-2).join('/') : 'native';
    const key = `${functionName}\0${script}`;
    const entry = selfTimeByFrame.get(key) || {functionName, script: script.startsWith('/') ? script : `/${script}`, selfMs: 0};
    entry.selfMs += selfMs;
    selfTimeByFrame.set(key, entry);

    const frames: Array<{functionName: string, script: string}> = [];
    let currentNodeId: number | undefined = nodeId;
    while(currentNodeId !== undefined && frames.length < 20) {
      const currentCallFrame = callFrames.get(currentNodeId);
      if(!currentCallFrame) break;
      const currentFunctionName = currentCallFrame.functionName || '(anonymous)';
      if(currentFunctionName !== '(root)') {
        const currentPath = currentCallFrame.url ? new URL(currentCallFrame.url, 'https://trace.invalid').pathname : '';
        const currentScript = currentPath ? currentPath.split('/').slice(-2).join('/') : 'native';
        frames.push({
          functionName: currentFunctionName,
          script: currentScript.startsWith('/') ? currentScript : `/${currentScript}`
        });
      }
      currentNodeId = parentIds.get(currentNodeId);
    }

    frames.reverse();
    const stackFrames = frames.slice(-10);
    const stackKey = JSON.stringify(stackFrames);
    const stack = selfTimeByStack.get(stackKey) || {frames: stackFrames, selfMs: 0};
    stack.selfMs += selfMs;
    selfTimeByStack.set(stackKey, stack);
    sampledCpuMs += selfMs;
  });

  return {
    sampledCpuMs: Number(sampledCpuMs.toFixed(2)),
    topFrames: [...selfTimeByFrame.values()]
      .sort((left, right) => right.selfMs - left.selfMs)
      .slice(0, 20)
      .map((frame) => ({...frame, selfMs: Number(frame.selfMs.toFixed(2))})),
    topStacks: [...selfTimeByStack.values()]
      .sort((left, right) => right.selfMs - left.selfMs)
      .slice(0, 20)
      .map((stack) => ({...stack, selfMs: Number(stack.selfMs.toFixed(2))}))
  };
}

// * Attributes each long task to the instrumented spans that began inside it and to the CPU samples
// * taken while it ran. `perfStartMs` is `performance.now()` read right after the profiler started,
// * which anchors the profile's relative time deltas to the page clock the long tasks use.
export function summarizeLongTaskAttribution(
  tasks: Array<{startTime: number, duration: number}>,
  spans: PerformanceSpan[],
  profile: PerformanceCpuProfile,
  perfStartMs: number,
  windowStartMs: number
): PerformanceTaskAttribution[] {
  const callFrames = new Map(profile.nodes.map(({id, callFrame}) => [id, callFrame]));
  const parentIds = new Map<number, number>();
  profile.nodes.forEach(({id, children = []}) => {
    children.forEach((childId) => parentIds.set(childId, id));
  });
  const round = (value: number) => Number(value.toFixed(2));

  const samples: Array<{nodeId: number, endMs: number, deltaMs: number}> = [];
  let elapsedUs = 0;
  (profile.samples || []).forEach((nodeId, index) => {
    const delta = Math.max(0, profile.timeDeltas?.[index] || 0);
    elapsedUs += delta;
    samples.push({nodeId, endMs: perfStartMs + elapsedUs / 1000, deltaMs: delta / 1000});
  });

  return tasks.filter(({duration}) => duration > 50).map((task) => {
    const taskEnd = task.startTime + task.duration;
    const byStack = new Map<string, {frames: Array<{functionName: string, script: string}>, selfMs: number}>();
    samples.forEach(({nodeId, endMs, deltaMs}) => {
      const overlap = Math.min(endMs, taskEnd) - Math.max(endMs - deltaMs, task.startTime);
      if(overlap <= 0) return;

      const frames: Array<{functionName: string, script: string}> = [];
      let currentNodeId: number | undefined = nodeId;
      while(currentNodeId !== undefined && frames.length < 20) {
        const callFrame = callFrames.get(currentNodeId);
        if(!callFrame) break;
        const functionName = callFrame.functionName || '(anonymous)';
        if(functionName !== '(root)') {
          const path = callFrame.url ? new URL(callFrame.url, 'https://trace.invalid').pathname : '';
          const script = path ? path.split('/').slice(-2).join('/') : 'native';
          frames.push({functionName, script: script.startsWith('/') ? script : `/${script}`});
        }
        currentNodeId = parentIds.get(currentNodeId);
      }

      const stackFrames = frames.reverse().slice(-10);
      const key = JSON.stringify(stackFrames);
      const entry = byStack.get(key) || {frames: stackFrames, selfMs: 0};
      entry.selfMs += overlap;
      byStack.set(key, entry);
    });

    return {
      startTimeMs: round(task.startTime - windowStartMs),
      durationMs: round(task.duration),
      spans: spans
        .filter(({startMs}) => startMs >= task.startTime && startMs < taskEnd)
        .map(({name, startMs, syncMs}) => ({name, startOffsetMs: round(startMs - task.startTime), syncMs: round(syncMs)})),
      stacks: [...byStack.values()]
        .sort((left, right) => right.selfMs - left.selfMs)
        .slice(0, 6)
        .map((stack) => ({...stack, selfMs: round(stack.selfMs)}))
    };
  });
}

// * `PerformanceObserver.observe()` ignores an entry type the browser does not support instead of throwing, so
// * support has to be read from `supportedEntryTypes`. Self-contained on purpose: the e2e injects its source into
// * the page with `toString()`.
export function observeLongAnimationFrames(Observer: any, onEntries: (entries: any[]) => void): boolean {
  const supported = Observer && Observer.supportedEntryTypes;
  if(!supported || typeof supported.indexOf !== 'function' || supported.indexOf('long-animation-frame') === -1) return false;

  try {
    new Observer((list: any) => onEntries(list.getEntries())).observe({type: 'long-animation-frame', buffered: true});
    return true;
  } catch{
    return false;
  }
}
