import {afterEach, expect, test, vi} from 'vitest';

vi.mock('@helpers/setWorkerProxy', () => ({makeWorkerURL: (url: string | URL) => new URL(url, location.href)}));
vi.mock('@helpers/createPrivateWorkerBlobURL', () => ({rewritePrivateWorkerImports: (text: string) => text}));
vi.mock('@environment/sharedWorkerSupport', () => ({default: false}));
vi.mock('@environment/userAgent', () => ({IS_SAFARI: false}));

const workerInstances: Worker[] = [];
class Worker extends EventTarget {
  public terminated = false;

  constructor(public url: string) {
    super();
    workerInstances.push(this);
  }

  public postMessage() {}

  public terminate() {
    this.terminated = true;
  }
}

vi.stubGlobal('Worker', Worker);
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
vi.stubGlobal('fetch', () => new Promise(() => {}));

type PortListener = (payload: void, source: MessageEventSource, event: MessageEvent) => void;

class TestSuperMessagePort {
  private portListeners = new Set<PortListener>();
  public attached: object[] = [];
  public detached: object[] = [];

  public get portListenerCount() {
    return this.portListeners.size;
  }

  public addEventListener(event: string, listener: PortListener) {
    if(event === 'port') this.portListeners.add(listener);
  }

  public removeEventListener(event: string, listener: PortListener) {
    if(event === 'port') this.portListeners.delete(listener);
  }

  public attachPort(port: object) {
    this.attached.push(port);
  }

  public detachPort(port: object) {
    this.detached.push(port);
    this.attached = this.attached.filter((attached) => attached !== port);
  }

  public emitPort(port: MessagePort) {
    const event = {ports: [port]} as unknown as MessageEvent;
    for(const listener of this.portListeners) listener(undefined, null, event);
  }
}

afterEach(() => {
  workerInstances.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(['worker-source fetch', 'proxy-URL request'] as const)('cleans up an attached worker after a %s failure before retrying', async(failureStage) => {
  const registerThreadedLottieWorker = (await import('@lib/lottie/registerThreadedWorker')).default;
  workerInstances.length = 0;
  vi.stubGlobal('Worker', Worker);
  const messagePort = new TestSuperMessagePort();
  const invokeVoid = vi.fn();
  const createProxyWorkerURLs = vi.fn();
  const failedWorkerPort = {close: vi.fn()} as unknown as MessagePort;
  const fetchError = new Error('worker source fetch failed');

  vi.stubGlobal('fetch', vi.fn(async() => {
    messagePort.emitPort(failedWorkerPort);
    if(failureStage === 'worker-source fetch') throw fetchError;
    return {text: async() => ''};
  }));
  if(failureStage === 'proxy-URL request') createProxyWorkerURLs.mockRejectedValueOnce(fetchError);

  const createWorker = () => new (window as any).Worker(new URL('/assets/lottie.worker.js', location.href), {type: 'module'});
  const registration = {
    createWorker,
    superMessagePort: messagePort as any,
    attachWorkerToPort: (worker: globalThis.Worker | SharedWorker) => messagePort.attachPort((worker as SharedWorker).port || worker),
    createProxyWorkerURLs,
    forwardPort: (port: MessagePort) => invokeVoid('threadedPort', 'lottie', undefined, [port])
  };

  await expect(registerThreadedLottieWorker(registration)).rejects.toBe(fetchError);
  expect(messagePort.attached).toEqual([]);
  expect(messagePort.detached).toHaveLength(1);
  expect(messagePort.portListenerCount).toBe(0);
  expect(workerInstances[0].terminated).toBe(true);
  expect((failedWorkerPort as any).close).toHaveBeenCalledOnce();
  expect(invokeVoid).not.toHaveBeenCalled();

  const retryWorkerPort = {close: vi.fn()} as unknown as MessagePort;
  vi.stubGlobal('fetch', vi.fn(async() => {
    messagePort.emitPort(retryWorkerPort);
    return {text: async() => ''};
  }));
  createProxyWorkerURLs.mockResolvedValue(['original-worker.js', 'proxy-worker.js']);

  await registerThreadedLottieWorker(registration);
  expect(messagePort.portListenerCount).toBe(1);
  expect(invokeVoid).toHaveBeenCalledOnce();
  expect(invokeVoid).toHaveBeenCalledWith('threadedPort', 'lottie', undefined, [retryWorkerPort]);
});
