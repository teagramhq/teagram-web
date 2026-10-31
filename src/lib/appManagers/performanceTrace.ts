export type PerformancePhase = {
  name: string,
  startedAtEpochMs: number,
  durationMs: number | null,
  accountNumber?: number
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
  private phases: PerformancePhase[] = [];

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public start(name: string, details: {accountNumber?: number} = {}) {
    if(!this.enabled) return () => {};

    const started = performance.now();
    const phase: PerformancePhase = {
      name,
      startedAtEpochMs: performance.timeOrigin + started,
      durationMs: null,
      ...(details.accountNumber === undefined ? {} : {accountNumber: details.accountNumber})
    };
    this.phases.push(phase);

    let finished = false;
    return () => {
      if(finished) return;
      finished = true;
      phase.durationMs = Number((performance.now() - started).toFixed(2));
    };
  }

  public reset() {
    this.phases = [];
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

export const performancePhaseTrace = new PerformancePhaseTrace(import.meta.env.VITE_PERF_TRACE === '1');
