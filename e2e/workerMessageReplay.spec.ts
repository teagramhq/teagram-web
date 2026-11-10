import {build} from 'esbuild';
import {expect, test} from '@playwright/test';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {PERFORMANCE_REPEATS} from '../scripts/performance/policy.mjs';

test('replay keeps worker output and order while recording recorder overhead', async({page}) => {
  await page.route('https://worker-replay.invalid/', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    headers: {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'},
    body: '<!doctype html><title>Worker replay</title>'
  }));
  await page.goto('https://worker-replay.invalid/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const bundle = await build({
    entryPoints: [resolve('e2e/workerReplayHarness.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    define: {
      'import.meta.env': JSON.stringify({DEV: false, MODE: 'production'}),
      '__MTPROTO_TARGET__': JSON.stringify({mode: 'telegram'}),
      '__MTPROTO_PRIVATE__': 'false'
    },
    logLevel: 'silent'
  });
  await page.addScriptTag({content: bundle.outputFiles[0].text});
  const result = await page.evaluate(async(repeats) => {
    const {SuperMessagePort, reconcilePeer, usePeers, installWorkerMessageAttribution} = (window as any).__workerReplay;
    const port = new SuperMessagePort('replay');
    const originalHandlers = {...port.processTaskMap};
    let order: number[] = [];
    let dialogTotal = 0;
    let firstEvent: unknown;
    let eventChanged = false;
    const observeEvent = (event: unknown) => {
      if(firstEvent === undefined) firstEvent = event;
      else if(firstEvent !== event) eventChanged = true;
    };
    port.addEventListener('mirror', (payload: any, _source: unknown, event: unknown) => {
      observeEvent(event);
      order.push(Number(payload.key));
      reconcilePeer(payload.key, payload.value);
    });
    port.addEventListener('event', (payload: any, _source: unknown, event: unknown) => {
      observeEvent(event);
      order.push(-1);
      if(payload.name === 'dialogs_multiupdate') {
        for(const [peerId, value] of payload.args[0] as Map<number, any>) dialogTotal += peerId + value.dialog.top_message;
      }
    });
    const peers = Array.from({length: 10_001}, (_, index) => ({
      id: index + 1,
      type: 'invoke',
      payload: {type: 'mirror', void: true, payload: {name: 'peers', accountNumber: 1, key: String(index + 1), value: {_: 'user', id: index + 1, pFlags: {}, first_name: `Peer ${index + 1}`}}}
    }));
    const event = (name: string, args: unknown[]) => ({id: 10_001, type: 'invoke', payload: {type: 'event', void: true, payload: {name, args, accountNumber: 1}}});
    const dialogs = new Map(Array.from({length: 10_000}, (_, index) => [index + 1, {dialog: {_: 'dialog', top_message: index + 1}}]));
    const batches = {
      peers: {type: 'batch', payload: peers},
      dialogs: {type: 'batch', payload: [event('dialogs_multiupdate', [dialogs])]}
    };
    const results: Record<string, {off: number[], on: number[]}> = {};
    const expectedPeerOrder = Array.from({length: 10_001}, (_, index) => index + 1);
    const outputs: Record<string, unknown[]> = {};
    for(const [name, batch] of Object.entries(batches)) {
      const timings: {off: number[], on: number[]} = results[name] = {off: [], on: []};
      const batchesPerSample = name === 'dialogs' ? 100 : 1;
      outputs[name] = [];
      for(let iteration = 0; iteration < 55; ++iteration) {
        const modes = iteration % 2 ? ['on', 'off'] : ['off', 'on'];
        for(const mode of modes) {
          const fixture = structuredClone(batch);
          order = [];
          dialogTotal = 0;
          eventChanged = false;
          const recording = mode === 'on' ? installWorkerMessageAttribution(port, () => performance.now()) : undefined;
          const started = performance.now();
          for(let batchIndex = 0; batchIndex < batchesPerSample; ++batchIndex) {
            firstEvent = undefined;
            port.onMessage({data: fixture, source: null, currentTarget: null});
          }
          const elapsed = (performance.now() - started) / batchesPerSample;
          recording?.restore();
          if(Object.keys(originalHandlers).some((type) => port.processTaskMap[type] !== originalHandlers[type])) {
            throw new Error(`${name} ${mode}: recorder left a handler installed`);
          }
          if(eventChanged) throw new Error(`${name} ${mode}: event identity differs within a batch`);
          if(recording && (recording.batches.length !== batchesPerSample || recording.spans.some((span: any) =>
            span.type !== (name === 'peers' ? 'invoke:mirror:peers' : 'invoke:event:dialogs_multiupdate')
          ))) throw new Error(`${name} ${mode}: attribution is incomplete`);
          if(iteration >= 5) timings[mode as 'off' | 'on'].push(elapsed);
          const expected = name === 'peers' ? expectedPeerOrder : Array(batchesPerSample).fill(-1);
          if(order.length !== expected.length || order.some((value, index) => value !== expected[index])) throw new Error(`${name} ${mode}: processing order differs`);
          if(name === 'peers') {
            for(let peerId = 1; peerId <= 10_001; ++peerId) {
              if(usePeers()[String(peerId)]?.id !== peerId) throw new Error(`${mode}: peer output differs at ${peerId}`);
            }
          } else if(dialogTotal !== 10_001_000_000) throw new Error(`${mode}: dialog output differs`);
          const output = name === 'peers' ? [usePeers()['1']?.id, usePeers()['10001']?.id, order.length] : [dialogTotal, order.length];
          outputs[name].push(output);
        }
      }
      if(outputs[name].some((output) => JSON.stringify(output) !== JSON.stringify(outputs[name][0]))) throw new Error(`${name}: output differs`);
    }
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const groupedMedians = (values: number[]) => Array.from({length: repeats}, (_, index) => {
      const start = Math.floor(index * values.length / repeats);
      const end = Math.floor((index + 1) * values.length / repeats);
      return median(values.slice(start, end));
    });
    return Object.fromEntries(Object.entries(results).map(([name, value]) => {
      const pairedDeltaSamples = groupedMedians(value.on.map((on, index) => on - value.off[index]));
      return [name, {
        offMs: median(value.off),
        onMs: median(value.on),
        pairedDeltaMs: median(pairedDeltaSamples),
        pairedDeltaSamples,
        iterations: value.off.length,
        output: outputs[name][0]
      }];
    }));
  }, PERFORMANCE_REPEATS);
  console.log('WORKER_REPLAY', JSON.stringify(result));
  if(process.env.PERF_RECORDER_REPLAY_PATH) writeFileSync(process.env.PERF_RECORDER_REPLAY_PATH, JSON.stringify(result, null, 2));
  for(const [name, measurement] of Object.entries(result) as Array<[string, any]>) {
    expect(measurement.iterations).toBeGreaterThanOrEqual(50);
    expect(measurement.pairedDeltaSamples).toHaveLength(PERFORMANCE_REPEATS);
    expect(Number.isFinite(measurement.offMs) && Number.isFinite(measurement.onMs) && Number.isFinite(measurement.pairedDeltaMs) && measurement.pairedDeltaSamples.every(Number.isFinite), `${name}: recorder timing samples are incomplete`).toBe(true);
  }
});
