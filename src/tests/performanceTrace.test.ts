import {describe, expect, test} from 'vitest';
import {PerformancePhaseTrace, PerformanceRpcTrace} from '@lib/appManagers/performanceTrace';

describe('performance trace collectors', () => {
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
    const handle = trace.start('messages.getHistory');
    trace.finish(handle, 'success');

    expect(trace.getSnapshot()).toEqual({enabled: true, recording: false, callCount: 1, calls: []});
  });

  test('records method and duration spans without arguments', () => {
    const trace = new PerformanceRpcTrace(true);
    const handle = trace.start('help.getAppConfig');
    trace.finish(handle, 'success');
    const snapshot = trace.getSnapshot();

    expect(snapshot.callCount).toBe(1);
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]).toMatchObject({method: 'help.getAppConfig', outcome: 'success'});
    expect(snapshot.calls[0].durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(snapshot)).not.toContain('params');
  });

  test('tracks resolved RPC requests through completion', async() => {
    const trace = new PerformanceRpcTrace(true);
    const handle = trace.start('help.getAppConfig');
    const request = Promise.resolve('config');
    const tracked = trace.track(handle, request);

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
    const handle = trace.start('messages.getHistory');
    const error = new Error('request failed');
    const request = Promise.reject(error);
    const tracked = trace.track(handle, request);

    expect(tracked).toBe(request);
    await expect(tracked).rejects.toBe(error);

    const snapshot = trace.getSnapshot();
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]).toMatchObject({method: 'messages.getHistory', outcome: 'error'});
    expect(Number.isFinite(snapshot.calls[0].durationMs)).toBe(true);
    expect(snapshot.calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
