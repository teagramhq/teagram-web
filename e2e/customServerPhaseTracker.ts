export type PhaseStatus = 'started' | 'active' | 'completed' | 'failed';

export type PhaseDiagnostic = {
  phase: string,
  status: PhaseStatus,
  elapsedMs: number,
  lastCompletedPhase: string | null
};

export function createPhaseTracker(onDiagnostic: (diagnostic: PhaseDiagnostic) => void, now = Date.now) {
  let activePhase: {name: string, startedAt: number, status: 'active' | 'failed'} | undefined;
  let lastCompletedPhase: string | null = null;

  const report = (phase: string, status: PhaseStatus, elapsedMs: number) => {
    onDiagnostic({phase, status, elapsedMs, lastCompletedPhase});
  };

  return {
    async run<T>(phase: string, operation: () => Promise<T> | T): Promise<T> {
      const startedAt = now();
      activePhase = {name: phase, startedAt, status: 'active'};
      report(phase, 'started', 0);

      try {
        const result = await operation();
        lastCompletedPhase = phase;
        activePhase = undefined;
        report(phase, 'completed', Math.max(0, now() - startedAt));
        return result;
      } catch(error) {
        activePhase.status = 'failed';
        report(phase, 'failed', Math.max(0, now() - startedAt));
        throw error;
      }
    },
    reportActive() {
      if(!activePhase) return;
      report(activePhase.name, activePhase.status, Math.max(0, now() - activePhase.startedAt));
    }
  };
}
