import {describe, expect, test} from 'vitest';
import {PerformancePhaseTrace, PerformanceRpcTrace} from '@lib/appManagers/performanceTrace';

describe('performance trace collectors', () => {
  test('records named phases in the page performance timeline', () => {
    const name = 'main.chatlist.mount.test';
    performance.clearMeasures(name);
    const trace = new PerformancePhaseTrace(true);

    const result = trace.track(name, () => 'mounted');
    const phase = trace.getSnapshot()[0];
    const [measure] = performance.getEntriesByName(name, 'measure');

    expect(result).toBe('mounted');
    expect(measure).toBeTruthy();
    expect(Math.abs(phase.startedAtEpochMs - performance.timeOrigin - measure.startTime)).toBeLessThan(0.01);
    expect(Math.abs(phase.durationMs - measure.duration)).toBeLessThan(0.01);
    performance.clearMeasures(name);
  });

  test('tracks promise phases until the operation resolves', async() => {
    const name = 'main.states.load.test';
    performance.clearMeasures(name);
    const trace = new PerformancePhaseTrace(true);
    const promise = Promise.resolve('loaded');

    await expect(trace.track(name, () => promise)).resolves.toBe('loaded');

    expect(trace.getSnapshot()[0]).toMatchObject({name, durationMs: expect.any(Number)});
    expect(performance.getEntriesByName(name, 'measure')).toHaveLength(1);
    performance.clearMeasures(name);
  });

  test('finishes promise phases without swallowing operation errors', async() => {
    const name = 'main.states.send.test';
    performance.clearMeasures(name);
    const trace = new PerformancePhaseTrace(true);
    const error = new Error('send failed');
    const promise = Promise.reject(error);

    await expect(trace.track(name, () => promise)).rejects.toBe(error);

    expect(trace.getSnapshot()[0]).toMatchObject({name, durationMs: expect.any(Number)});
    expect(performance.getEntriesByName(name, 'measure')).toHaveLength(1);
    performance.clearMeasures(name);
  });

  test('returns the original operation result without recording when disabled', () => {
    const name = 'main.chatlist.mount.disabled-test';
    performance.clearMeasures(name);
    const trace = new PerformancePhaseTrace(false);
    const promise = Promise.resolve('mounted');

    expect(trace.track(name, () => promise)).toBe(promise);
    expect(trace.getSnapshot()).toEqual([]);
    expect(performance.getEntriesByName(name, 'measure')).toEqual([]);
  });

  test('records worker phases without retaining arbitrary details', () => {
    const trace = new PerformancePhaseTrace(true);
    const finish = trace.start('worker.storage.load', {accountNumber: 2});
    finish();
    finish();

    expect(trace.getSnapshot()).toEqual([
      expect.objectContaining({name: 'worker.storage.load', accountNumber: 2})
    ]);
  });

  test('counts RPC calls without recording their spans when detail tracing is disabled', () => {
    const trace = new PerformanceRpcTrace(true);
    trace.reset(false);
    trace.recordCall('messages.getHistory');
    const handle = trace.start('messages.getHistory');
    trace.finish(handle, 'success');

    expect(trace.getSnapshot()).toEqual({enabled: true, recording: false, callCount: 1, invocations: [], calls: []});
  });

  test('counts invocations without attributing an unconsumed wait span', () => {
    const trace = new PerformanceRpcTrace(true);
    trace.recordCall('messages.getHistory');

    const snapshot = trace.getSnapshot();
    expect(snapshot).toMatchObject({
      enabled: true,
      recording: true,
      callCount: 1,
      invocations: [{method: 'messages.getHistory'}],
      calls: []
    });
    expect(Number.isFinite(snapshot.invocations[0].startedAtEpochMs)).toBe(true);
  });

  test('records explicit RPC waits without changing invocation counts', async() => {
    const trace = new PerformanceRpcTrace(true);
    trace.recordCall('help.getAppConfig');
    const request = Promise.resolve('config');
    const tracked = trace.trackWait('help.getAppConfig', request);

    expect(tracked).toBe(request);
    await expect(tracked).resolves.toBe('config');

    const snapshot = trace.getSnapshot();

    expect(snapshot.callCount).toBe(1);
    expect(snapshot.invocations).toHaveLength(1);
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]).toMatchObject({method: 'help.getAppConfig', outcome: 'success'});
    expect(snapshot.calls[0].durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(snapshot)).not.toContain('params');
  });

  test('tracks resolved RPC requests through completion', async() => {
    const trace = new PerformanceRpcTrace(true);
    const request = Promise.resolve('config');
    const tracked = trace.trackWait('help.getAppConfig', request);

    expect(tracked).toBe(request);
    await expect(tracked).resolves.toBe('config');

    const snapshot = trace.getSnapshot();
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]).toMatchObject({method: 'help.getAppConfig', outcome: 'success'});
    expect(Number.isFinite(snapshot.calls[0].durationMs)).toBe(true);
    expect(snapshot.calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test('tracks rejected RPC requests through completion without swallowing the error', async() => {
    const trace = new PerformanceRpcTrace(true);
    const error = new Error('request failed');
    const request = Promise.reject(error);
    const tracked = trace.trackWait('messages.getHistory', request);

    expect(tracked).toBe(request);
    await expect(tracked).rejects.toBe(error);

    const snapshot = trace.getSnapshot();
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]).toMatchObject({method: 'messages.getHistory', outcome: 'error'});
    expect(Number.isFinite(snapshot.calls[0].durationMs)).toBe(true);
    expect(snapshot.calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
