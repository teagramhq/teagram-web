export type PerformancePhase = {
  name: string,
  startedAtEpochMs: number,
  durationMs: number | null,
  traceId?: string,
  accountNumber?: number,
  pageCount?: number
};

export type PerformanceRpcCall = {
  method: string,
  startedAtEpochMs: number,
  durationMs: number | null,
  outcome: 'pending' | 'success' | 'error'
};

export type PerformanceRpcInvocation = {
  method: string,
  startedAtEpochMs: number
};

export type PerformanceRpcHandle = {
  trace: PerformanceRpcCall,
  started: number
};

export class PerformancePhaseTrace {
  private readonly enabled: boolean;
  private readonly alwaysEnabledNames: Set<string>;
  private phases: PerformancePhase[] = [];

  constructor(enabled: boolean, alwaysEnabledNames: string[] = []) {
    this.enabled = enabled;
    this.alwaysEnabledNames = new Set(alwaysEnabledNames);
  }

  public start(
    name: string,
    details: {accountNumber?: number, startedAtEpochMs?: number, traceId?: string, pageCount?: number} = {}
  ): (summary?: {pageCount?: number}) => void {
    if(!this.enabled && !this.alwaysEnabledNames.has(name)) return () => {};

    const started = performance.now();
    const startedAtEpochMs = details.startedAtEpochMs ?? performance.timeOrigin + started;
    const phase: PerformancePhase = {
      name,
      startedAtEpochMs,
      durationMs: null,
      ...(details.traceId === undefined ? {} : {traceId: details.traceId}),
      ...(details.accountNumber === undefined ? {} : {accountNumber: details.accountNumber}),
      ...(details.pageCount === undefined ? {} : {pageCount: details.pageCount})
    };
    this.phases.push(phase);

    let finished = false;
    return (summary = {}) => {
      if(finished) return;
      finished = true;
      if(summary.pageCount !== undefined) phase.pageCount = summary.pageCount;
      const duration = Number((performance.timeOrigin + performance.now() - startedAtEpochMs).toFixed(2));
      phase.durationMs = duration;
      if(name.startsWith('main.')) performance.measure(name, {start: startedAtEpochMs - performance.timeOrigin, duration});
    };
  }

  // A phase that is still running reports the pages seen so far, for a reader that never sees it finish.
  public setPageCount(traceId: string, pageCount: number) {
    const phase = this.phases.find((candidate) => candidate.traceId === traceId && candidate.durationMs === null);
    if(phase) phase.pageCount = pageCount;
  }

  public reset(preserveNames: string[] = []) {
    this.phases = this.phases.filter(({name}) => preserveNames.includes(name));
  }

  public track<T>(name: string, operation: () => T): T {
    if(!this.enabled) return operation();

    const finish = this.start(name);
    try {
      const result = operation();
      if(result instanceof Promise) return result.finally(finish) as T;
      finish();
      return result;
    } catch(error) {
      finish();
      throw error;
    }
  }

  public getSnapshot() {
    return this.phases.map((phase) => ({...phase}));
  }
}

export class PerformanceRpcTrace {
  private readonly enabled: boolean;
  private recording: boolean;
  private callCount = 0;
  private invocations: PerformanceRpcInvocation[] = [];
  private calls: PerformanceRpcCall[] = [];

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.recording = enabled;
  }

  public reset(recordSpans = true) {
    this.invocations = [];
    this.calls = [];
    this.callCount = 0;
    this.recording = this.enabled && recordSpans;
  }

  public recordCall(method: string) {
    if(!this.enabled) return;
    ++this.callCount;
    if(!this.recording) return;

    this.invocations.push({
      method,
      startedAtEpochMs: performance.timeOrigin + performance.now()
    });
  }

  public start(method: string): PerformanceRpcHandle | undefined {
    if(!this.enabled) return;
    if(!this.recording) return;

    const started = performance.now();
    const trace: PerformanceRpcCall = {
      method,
      startedAtEpochMs: performance.timeOrigin + started,
      durationMs: null,
      outcome: 'pending'
    };
    this.calls.push(trace);
    return {trace, started};
  }

  public finish(handle: PerformanceRpcHandle | undefined, outcome: 'success' | 'error') {
    if(!handle) return;
    handle.trace.durationMs = Number((performance.now() - handle.started).toFixed(2));
    handle.trace.outcome = outcome;
  }

  public track<T, P extends Promise<T>>(handle: PerformanceRpcHandle | undefined, request: P): P {
    if(handle) {
      request.then(
        () => this.finish(handle, 'success'),
        () => this.finish(handle, 'error')
      );
    }
    return request;
  }

  public trackWait<T, P extends Promise<T>>(method: string, request: P): P {
    return this.track(this.start(method), request);
  }

  public getSnapshot() {
    return {
      enabled: this.enabled,
      recording: this.recording,
      callCount: this.callCount,
      invocations: this.invocations.map((invocation) => ({...invocation})),
      calls: this.calls.map((trace) => ({...trace}))
    };
  }
}

const reconcileTraceEnabled = import.meta.env.VITE_PERF_TRACE === '1' || import.meta.env.VITE_PERF_RECONCILE_TRACE === '1';

export const performancePhaseTrace = new PerformancePhaseTrace(
  import.meta.env.VITE_PERF_TRACE === '1',
  reconcileTraceEnabled ? ['worker.dialogs.cachedChannelReconcile'] : []
);
