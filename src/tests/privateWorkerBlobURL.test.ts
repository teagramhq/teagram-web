import {afterEach, describe, expect, it, vi} from 'vitest';
import {createPrivateWorkerBlobURL} from '@helpers/createPrivateWorkerBlobURL';

const ENTRY_URL = 'https://web.teagram.io/src/lib/mainWorker/index.worker.ts';

async function readBlobSource(url: string) {
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
  expect(url).toBe('blob:worker');
  return blob.text();
}

describe('private worker blob URL', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers SharedWorker connections that arrive while the entry is still importing', async() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:worker');
    const source = await readBlobSource(await createPrivateWorkerBlobURL(ENTRY_URL, 'custom-a', {mode: 'private'}));

    const scope = new EventTarget() as EventTarget & Record<string, unknown>;
    const connected: unknown[] = [];
    let finishImport: () => void;
    const importEntry = vi.fn((url: string) => {
      expect(url).toBe(ENTRY_URL);
      expect(scope.__TEAGRAM_ACTIVE_SERVER_ID__).toBe('custom-a');
      return new Promise<void>((resolve) => {
        finishImport = () => {
          scope.addEventListener('connect', (event) => connected.push((event as MessageEvent).source));
          resolve();
        };
      });
    });

    const AsyncFunction = Object.getPrototypeOf(async() => {}).constructor;
    const run = new AsyncFunction('globalThis', 'importEntry', source.replace(/\bimport\(/g, 'importEntry('));
    const running = run(scope, importEntry);

    const {port1} = new MessageChannel();
    const connectEvent = new Event('connect') as MessageEvent;
    Object.defineProperties(connectEvent, {
      source: {value: null},
      ports: {value: [port1]}
    });
    scope.dispatchEvent(connectEvent);
    finishImport();
    await running;

    expect(connected.length).toBe(1);
    expect(connected[0]).toBe(port1);
    port1.close();
  });
});
