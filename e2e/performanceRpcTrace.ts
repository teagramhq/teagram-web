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
    callFrame: {functionName?: string, url?: string}
  }>,
  samples?: number[],
  timeDeltas?: number[]
};

export type PerformanceCpuSummary = {
  sampledCpuMs: number,
  topFrames: Array<{functionName: string, script: string, selfMs: number}>
};

export type PerformancePhaseSummary = {
  name: string,
  durationMs: number | null,
  accountNumber?: number,
  startMs?: number
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

export function summarizePerformancePhases<T extends {name: string, durationMs: number | null, accountNumber?: number, startMs?: number}>(phases: T[]): PerformancePhaseSummary[] {
  return phases.map(({name, durationMs, accountNumber, startMs}) => ({
    name,
    durationMs: Number.isFinite(durationMs) ? Number(durationMs!.toFixed(2)) : null,
    ...(accountNumber === undefined ? {} : {accountNumber}),
    ...(startMs === undefined ? {} : {startMs: Number(startMs.toFixed(2))})
  }));
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
