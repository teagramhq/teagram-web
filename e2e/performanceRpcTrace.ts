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
    callFrame: {functionName?: string, url?: string, lineNumber?: number, columnNumber?: number},
    children?: number[]
  }>,
  samples?: number[],
  timeDeltas?: number[]
};

export type PerformanceCpuTaskSummary = {
  startTime: number,
  duration: number,
  sampledCpuMs: number,
  topStacks: Array<{frames: string[], sampledCpuMs: number}>
};

export type PerformanceCpuSummary = {
  sampledCpuMs: number,
  topFrames: Array<{functionName: string, script: string, selfMs: number}>
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
  const selfTimeByFrame = new Map<string, {functionName: string, script: string, selfMs: number}>();
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
    sampledCpuMs += selfMs;
  });

  return {
    sampledCpuMs: Number(sampledCpuMs.toFixed(2)),
    topFrames: [...selfTimeByFrame.values()]
      .sort((left, right) => right.selfMs - left.selfMs)
      .slice(0, 20)
      .map((frame) => ({...frame, selfMs: Number(frame.selfMs.toFixed(2))}))
  };
}

export function summarizeCpuProfileLongTasks(
  profile: PerformanceCpuProfile,
  profileStartedAtMs: number,
  tasks: Array<{startTime: number, duration: number}>
): PerformanceCpuTaskSummary[] {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for(const node of profile.nodes) {
    for(const childId of node.children || []) {
      parents.set(childId, node.id);
    }
  }

  const summaries = tasks.map(({startTime, duration}) => ({
    startTime: Number(startTime.toFixed(2)),
    duration: Number(duration.toFixed(2)),
    sampledCpuMs: 0,
    topStacksByKey: new Map<string, {frames: string[], sampledCpuMs: number}>()
  }));
  let elapsedMs = 0;

  (profile.samples || []).forEach((nodeId, index) => {
    const sampledMs = Math.max(0, profile.timeDeltas?.[index] || 0) / 1000;
    elapsedMs += sampledMs;
    if(!sampledMs) return;

    const sampleTime = profileStartedAtMs + elapsedMs;
    const taskIndex = tasks.findIndex(({startTime, duration}) => sampleTime >= startTime && sampleTime < startTime + duration);
    if(taskIndex < 0) return;

    const path: string[] = [];
    let currentNodeId: number | undefined = nodeId;
    while(currentNodeId !== undefined) {
      const node = nodes.get(currentNodeId);
      if(!node) break;

      const {callFrame} = node;
      const functionName = callFrame.functionName || '(anonymous)';
      if(functionName !== '(root)') {
        const script = callFrame.url ? new URL(callFrame.url, 'https://trace.invalid').pathname.split('/').filter(Boolean).slice(-2).join('/') || 'native' : 'native';
        const line = callFrame.lineNumber === undefined ? '' : `:${callFrame.lineNumber + 1}`;
        const column = callFrame.columnNumber === undefined ? '' : `:${callFrame.columnNumber + 1}`;
        path.push(`${functionName} (${script}${line}${column})`);
      }
      currentNodeId = parents.get(currentNodeId);
    }
    path.reverse();

    const summary = summaries[taskIndex];
    summary.sampledCpuMs += sampledMs;
    const key = path.join('\0');
    const stack = summary.topStacksByKey.get(key) || {frames: path, sampledCpuMs: 0};
    stack.sampledCpuMs += sampledMs;
    summary.topStacksByKey.set(key, stack);
  });

  return summaries.map(({startTime, duration, sampledCpuMs, topStacksByKey}) => ({
    startTime,
    duration,
    sampledCpuMs: Number(sampledCpuMs.toFixed(2)),
    topStacks: [...topStacksByKey.values()]
      .sort((left, right) => right.sampledCpuMs - left.sampledCpuMs)
      .slice(0, 5)
      .map(({frames, sampledCpuMs}) => ({frames, sampledCpuMs: Number(sampledCpuMs.toFixed(2))}))
  }));
}
