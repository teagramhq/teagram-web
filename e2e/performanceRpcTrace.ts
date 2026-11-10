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
  walks: CachedDialogReconcileRunSummary[]
};

export type CachedDialogReconcileRunSummary = {
  traceId: string,
  pageCount: number | null,
  startRelativeToScenarioMs: number,
  endRelativeToScenarioMs: number,
  mainThreadTimeMs: number,
  pageCompletionOffsetsMs?: number[],
  // When the newest page was requested, relative to the scenario start; a request that predates the window and never completes is a stalled response.
  lastPageRequestOffsetMs?: number,
  // The page navigated away and took the worker with it before the walk finished; the end is that navigation.
  interrupted?: boolean
};

export type CachedDialogReconcilePhase = {
  traceId: string,
  pageCount?: number,
  startedAtEpochMs: number,
  durationMs: number | null,
  interrupted?: boolean
  pageCompletedAtEpochMs?: number[],
  lastPageRequestedAtEpochMs?: number
};

export type CachedDialogReconcileWindow = {
  scenarioStartedAtEpochMs: number,
  scenarioEndedAtEpochMs: number
};

export function mergeCachedDialogReconcilePhaseSnapshots(snapshots: CachedDialogReconcilePhase[][]): CachedDialogReconcilePhase[] {
  const phasesByTraceId = new Map<string, CachedDialogReconcilePhase>();
  snapshots.flat().forEach((phase) => {
    const previous = phasesByTraceId.get(phase.traceId);
    // Of two pending snapshots, the later one has seen more pages.
    const laterPending = previous?.durationMs === null && phase.durationMs === null && (phase.pageCount ?? 0) >= (previous.pageCount ?? 0);
    if(!previous || laterPending || (previous.durationMs === null && phase.durationMs !== null)) {
      phasesByTraceId.set(phase.traceId, phase);
    }
  });
  return [...phasesByTraceId.values()];
}

// A walk runs in the page's worker, so a navigation ends it without a completion record. A pending walk that
// the live worker no longer reports ended when the next page started; a walk the live worker still reports
// stays pending.
export function settleInterruptedCachedDialogReconciles(
  phases: CachedDialogReconcilePhase[],
  livePendingTraceIds: Iterable<string>,
  pageStartedAtEpochMs: number[]
): CachedDialogReconcilePhase[] {
  const live = new Set(livePendingTraceIds);
  return phases.map((phase) => {
    if(phase.durationMs !== null || live.has(phase.traceId)) return phase;
    const interruptedAtEpochMs = Math.min(...pageStartedAtEpochMs.filter((startedAt) => startedAt > phase.startedAtEpochMs));
    if(!Number.isFinite(interruptedAtEpochMs)) return phase;
    return {
      ...phase,
      durationMs: Number((interruptedAtEpochMs - phase.startedAtEpochMs).toFixed(2)),
      interrupted: true
    };
  });
}

export const CACHED_DIALOG_RECONCILE_PHASE_NAME = 'worker.dialogs.cachedChannelReconcile';

export function getScenarioPreservedPerformancePhases() {
  return [CACHED_DIALOG_RECONCILE_PHASE_NAME];
}

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
    ...(task.startTime - startedAtMs !== round(task.startTime - startedAtMs) || task.duration !== round(task.duration) ? {
      preciseStartTimeMs: task.startTime - startedAtMs,
      preciseDurationMs: task.duration
    } : {}),
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
  phase: CachedDialogReconcilePhase,
  scenarioStartedAtEpochMs: number,
  mainThreadTimeMs: number
): CachedDialogReconcileRunSummary {
  if(phase.durationMs === null) {
    throw new Error(`cached dialog reconciliation ${phase.traceId} has no completion time`);
  }
  const startRelativeToScenarioMs = phase.startedAtEpochMs - scenarioStartedAtEpochMs;
  return {
    ...(phase.interrupted ? {interrupted: true} : {}),
    traceId: phase.traceId,
    pageCount: phase.pageCount ?? null,
    startRelativeToScenarioMs: Number(startRelativeToScenarioMs.toFixed(2)),
    endRelativeToScenarioMs: Number((startRelativeToScenarioMs + phase.durationMs).toFixed(2)),
    mainThreadTimeMs: Number(mainThreadTimeMs.toFixed(2))
  };
}

export function collectCachedDialogReconciles(
  phases: CachedDialogReconcilePhase[],
  scenarioStartedAtEpochMs: number,
  scenarioEndedAtEpochMs: number,
  mainThreadTimeByTraceId: Record<string, number>
): CachedDialogReconcileSummary {
  const walks = phases.filter((phase) => {
    if(phase.startedAtEpochMs >= scenarioEndedAtEpochMs) return false;
    if(phase.durationMs === null) {
      throw new Error(`cached dialog reconciliation ${phase.traceId} is still running`);
    }
    return phase.startedAtEpochMs + phase.durationMs > scenarioStartedAtEpochMs;
  }).map((phase) => {
    // An interrupted walk can still flush per-page chat updates; use its recorded time when any were processed.
    const mainThreadTimeMs = mainThreadTimeByTraceId[phase.traceId] ?? (phase.interrupted ? 0 : undefined);
    if(!Number.isFinite(mainThreadTimeMs) || mainThreadTimeMs < 0) {
      throw new Error(`cached dialog reconciliation ${phase.traceId} has no main-thread time`);
    }
    const summary = summarizeCachedDialogReconcile(phase, scenarioStartedAtEpochMs, mainThreadTimeMs);
    if(phase.pageCompletedAtEpochMs) {
      summary.pageCompletionOffsetsMs = phase.pageCompletedAtEpochMs
      .filter((time) => time >= scenarioStartedAtEpochMs && time < scenarioEndedAtEpochMs)
      .map((time) => Number((time - scenarioStartedAtEpochMs).toFixed(2)));
    }
    if(phase.lastPageRequestedAtEpochMs !== undefined) {
      summary.lastPageRequestOffsetMs = Number((phase.lastPageRequestedAtEpochMs - scenarioStartedAtEpochMs).toFixed(2));
    }
    return summary;
  });
  return {walks};
}

// The reconcile walk starts after the live list renders, so a snapshot paint must not close its window.
export function cachedDialogReconcileWindowMs({ms, liveBoundaryMs}: {ms?: number, liveBoundaryMs?: number}) {
  return liveBoundaryMs ?? ms;
}

export function collectCachedDialogReconcileSummaries(
  windows: CachedDialogReconcileWindow[],
  phases: CachedDialogReconcilePhase[],
  mainThreadTimeByTraceId: Record<string, number>
): CachedDialogReconcileSummary[] {
  return windows.map(({scenarioStartedAtEpochMs, scenarioEndedAtEpochMs}) => collectCachedDialogReconciles(
    phases,
    scenarioStartedAtEpochMs,
    scenarioEndedAtEpochMs,
    mainThreadTimeByTraceId
  ));
}

function hasCompleteCachedDialogReconcileSummary(summary: CachedDialogReconcileSummary | undefined) {
  return !!summary && Array.isArray(summary.walks) && summary.walks.every((walk) => (
    typeof walk.traceId === 'string' &&
    Number.isFinite(walk.pageCount) &&
    walk.pageCount! >= 0 &&
    Number.isFinite(walk.startRelativeToScenarioMs) &&
    Number.isFinite(walk.endRelativeToScenarioMs) &&
    Number.isFinite(walk.mainThreadTimeMs) &&
    walk.mainThreadTimeMs >= 0
  ));
}

export function validateCachedDialogReconcileSummaries(
  samples: Array<{cachedDialogReconcile?: CachedDialogReconcileSummary}>,
  scenario: string,
  expectedRepeatCount: number
) {
  if(samples.length !== expectedRepeatCount) {
    throw new Error(`100x ${scenario} has ${samples.length} measured repeats; expected ${expectedRepeatCount}`);
  }

  samples.forEach(({cachedDialogReconcile}, index) => {
    if(!hasCompleteCachedDialogReconcileSummary(cachedDialogReconcile)) {
      throw new Error(`100x ${scenario} measured repeat ${index + 1} has incomplete reconciliation data`);
    }
  });
}

export function validateCachedDialogReconcileDiagnostics(
  samples: Array<{cachedDialogReconcile?: CachedDialogReconcileSummary, longTaskTrace?: unknown}>,
  scenario: string,
  expectedRepeatCount: number,
  requireWalk = false
) {
  if(samples.length !== expectedRepeatCount) {
    throw new Error(`100x ${scenario} has ${samples.length} diagnostic repeats; expected ${expectedRepeatCount}`);
  }

  samples.forEach(({cachedDialogReconcile, longTaskTrace}, index) => {
    const hasCompletedWalk = cachedDialogReconcile?.walks.some(({pageCount, interrupted}) => (
      !interrupted && pageCount !== null && Number.isFinite(pageCount) && pageCount > 0
    ));
    if(requireWalk && !hasCompletedWalk) {
      throw new Error(`100x ${scenario} diagnostic repeat ${index + 1} has no completed cached-dialog walk`);
    }
    if(
      !hasCompleteCachedDialogReconcileSummary(cachedDialogReconcile) ||
      !Array.isArray(longTaskTrace)
    ) {
      throw new Error(`100x ${scenario} diagnostic repeat ${index + 1} has incomplete reconciliation or long-task data`);
    }
  });
}

export function classifyMeasuredLongTaskTrace(
  {longTasksOver50Ms, longTaskTrace}: {longTasksOver50Ms?: number, longTaskTrace?: ReturnType<typeof summarizeLongTaskTrace>}
): 'complete' | 'partial' | 'missing' {
  if(!Array.isArray(longTaskTrace)) return 'missing';
  if(!Number.isFinite(longTasksOver50Ms) || longTaskTrace.length !== longTasksOver50Ms ||
    longTaskTrace.some(({scripts}) => !Array.isArray(scripts) || !scripts.length)) return 'partial';
  return 'complete';
}

type OverlapTask = {startTimeMs: number, durationMs: number, preciseStartTimeMs?: number, preciseDurationMs?: number};
export type ReconcileMirrorTask = OverlapTask & {traceId: string};

// Keeps the walk's main-thread mirror tasks that start inside the window, relative to its start.
export function summarizeReconcileMirrorTasks(
  tasks: Array<{traceId: string, startedAtMs: number, durationMs: number}>,
  startedAtMs: number,
  elapsedMs: number
): ReconcileMirrorTask[] {
  const round = (value: number) => Number(value.toFixed(2));
  return tasks
  .filter(({startedAtMs: taskStart}) => taskStart >= startedAtMs && taskStart < startedAtMs + elapsedMs)
  .map(({traceId, startedAtMs: taskStart, durationMs}) => ({
    traceId, startTimeMs: round(taskStart - startedAtMs), durationMs: round(durationMs),
    ...(taskStart - startedAtMs !== round(taskStart - startedAtMs) || durationMs !== round(durationMs) ? {
      preciseStartTimeMs: taskStart - startedAtMs, preciseDurationMs: durationMs
    } : {})
  }));
}

// Stack frames cannot attribute a task to the walk because history responses share the mirror path;
// a mirror task that carries the walk's traceId and runs inside the task can.
export function findLongTasksOverlappingWalkMirrors(
  tasks: OverlapTask[] | undefined,
  mirrorTasks: ReconcileMirrorTask[] | undefined
) {
  // Older reports have only hundredths of a millisecond. Preserve that precision
  // in the fallback; new reports retain the original timings for the comparison.
  const units = (value: number) => Math.round(value * 100);
  return (tasks || []).filter((task) => (task.preciseDurationMs ?? task.durationMs) > 50 && (mirrorTasks || []).some((mirror) => {
    if(task.preciseStartTimeMs === undefined && mirror.preciseStartTimeMs === undefined) {
      return units(mirror.startTimeMs) < units(task.startTimeMs) + units(task.durationMs) &&
        units(mirror.startTimeMs) + units(mirror.durationMs) > units(task.startTimeMs);
    }
    const taskStart = task.preciseStartTimeMs ?? task.startTimeMs;
    const taskEnd = taskStart + (task.preciseDurationMs ?? task.durationMs);
    const mirrorStart = mirror.preciseStartTimeMs ?? mirror.startTimeMs;
    const mirrorEnd = mirrorStart + (mirror.preciseDurationMs ?? mirror.durationMs);
    const epsilon = Number.EPSILON * Math.max(1, Math.abs(taskStart), Math.abs(taskEnd), Math.abs(mirrorStart), Math.abs(mirrorEnd)) * 4;
    return mirrorStart < taskEnd - epsilon && mirrorEnd > taskStart + epsilon;
  }));
}

export function buildWalkComparison(
  variants: Record<string, Record<string, Array<{longTaskTrace?: OverlapTask[], reconcileMirrorTasks?: ReconcileMirrorTask[]}>>>,
  expectedRepeatCount: number
) {
  return Object.fromEntries(Object.entries(variants).map(([variant, scenarios]) => [
    variant,
    Object.fromEntries(Object.entries(scenarios).map(([scenario, samples]) => {
      if(samples.length !== expectedRepeatCount) {
        throw new Error(`${variant} ${scenario} has ${samples.length} measured samples; expected ${expectedRepeatCount}`);
      }
      return [scenario, samples.map((sample, index) => {
        if(!Array.isArray(sample.longTaskTrace) || !Array.isArray(sample.reconcileMirrorTasks)) {
          throw new Error(`${variant} ${scenario} measured sample ${index + 1} has incomplete walk-mirror data`);
        }
        return {walkLongTasksOver50Ms: findLongTasksOverlappingWalkMirrors(sample.longTaskTrace, sample.reconcileMirrorTasks).length};
      })];
    }))
  ]));
}

// Tasks over 50 ms that no walk mirror task overlaps stay in the report; they are not a reconciliation failure.
export function validateNoWalkLongTasks(
  samples: Array<{longTaskTrace?: OverlapTask[], reconcileMirrorTasks?: ReconcileMirrorTask[]}>,
  label: string
) {
  samples.forEach(({longTaskTrace, reconcileMirrorTasks}, index) => {
    const tasks = findLongTasksOverlappingWalkMirrors(longTaskTrace, reconcileMirrorTasks);
    if(tasks.length) {
      throw new Error(`${label} repeat ${index + 1} has ${tasks.length} tasks over 50 ms overlapping a walk mirror task`);
    }
  });
}

export function rpcInvocationsInWindow<T extends {startedAtEpochMs: number}>(calls: T[], timeOrigin: number, startedAtMs: number, elapsedMs: number): T[] {
  const start = timeOrigin + startedAtMs;
  return calls.filter((call) => call.startedAtEpochMs >= start && call.startedAtEpochMs <= start + elapsedMs);
}

export function rpcMethodCounts(calls: Array<{method: string, startedAtEpochMs: number}>, timeOrigin: number, startedAtMs: number, elapsedMs: number) {
  return rpcInvocationsInWindow(calls, timeOrigin, startedAtMs, elapsedMs).reduce((counts, {method}) => {
    counts[method] = (counts[method] || 0) + 1;
    return counts;
  }, {} as Record<string, number>);
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
  windowStartMs: number,
  windowDurationMs: number,
  minimumDurationMs = 50
): PerformanceTaskAttribution[] {
  const windowEndMs = windowStartMs + windowDurationMs;
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

  return tasks.filter(({startTime, duration}) => {
    return startTime >= windowStartMs && startTime < windowEndMs && duration > minimumDurationMs;
  }).map((task) => {
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

export function selectHistoryPathTasks(tasks: PerformanceTaskAttribution[], spanNames: string[]) {
  const selectedNames = new Set(spanNames);
  return tasks.filter(({spans}) => spans.some(({name}) => selectedNames.has(name)));
}

export function findLongTasksWithSignificantSpanWork(tasks: PerformanceTaskAttribution[], spanNames: string[]): PerformanceTaskAttribution[] {
  const names = new Set(spanNames);
  return tasks.filter(({durationMs, spans}) => {
    const scrollSpans = spans.filter(({name}) => names.has(name));
    for(const {startOffsetMs, syncMs} of scrollSpans) {
      if(!Number.isFinite(startOffsetMs) || !Number.isFinite(syncMs)) {
        throw new Error('History scroll span timing must be finite');
      }
    }
    if(durationMs <= 50) return false;

    const intervals = scrollSpans
      .map(({startOffsetMs, syncMs}) => [Math.max(0, startOffsetMs), Math.min(durationMs, startOffsetMs + syncMs)] as [number, number])
      .filter(([startMs, endMs]) => endMs > startMs)
      .sort(([leftStart], [rightStart]) => leftStart - rightStart);
    let scrollWorkMs = 0;
    let currentStart = 0;
    let currentEnd = 0;
    let hasCurrent = false;

    for(const [startMs, endMs] of intervals) {
      if(!hasCurrent || startMs > currentEnd) {
        if(hasCurrent) scrollWorkMs += currentEnd - currentStart;
        currentStart = startMs;
        currentEnd = endMs;
        hasCurrent = true;
      } else {
        currentEnd = Math.max(currentEnd, endMs);
      }
    }
    if(hasCurrent) scrollWorkMs += currentEnd - currentStart;

    return scrollWorkMs > 50 || scrollWorkMs * 2 > durationMs;
  });
}

// * `PerformanceObserver.observe()` ignores an entry type the browser does not support instead of throwing, so
// * support has to be read from `supportedEntryTypes`. Self-contained on purpose: the e2e injects its source into
// * the page with `toString()`.
export function observeLongAnimationFrames(Observer: any, onEntries: (entries: any[]) => void, onObserver?: (observer: any) => void): boolean {
  const supported = Observer && Observer.supportedEntryTypes;
  if(!supported || typeof supported.indexOf !== 'function' || supported.indexOf('long-animation-frame') === -1) return false;

  try {
    const observer = new Observer((list: any) => onEntries(list.getEntries()));
    observer.observe({type: 'long-animation-frame', buffered: true});
    onObserver?.(observer);
    return true;
  } catch{
    return false;
  }
}
