import {afterEach, expect, test, vi} from 'vitest';

const workerState = vi.hoisted(() => {
  const instances: Array<{terminated: boolean, url: string}> = [];
  class TestWorker extends EventTarget {
    public terminated = false;

    constructor(public url: string) {
      super();
      instances.push(this);
    }

    public postMessage() {}

    public terminate() {
      this.terminated = true;
    }
  }

  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('fetch', () => new Promise(() => {}));

  return {instances, TestWorker};
});

vi.mock('@helpers/setWorkerProxy', () => ({makeWorkerURL: (url: string | URL) => new URL(url, location.href)}));
vi.mock('@helpers/createPrivateWorkerBlobURL', () => ({rewritePrivateWorkerImports: (text: string) => text}));
vi.mock('@components/animationIntersector', () => ({default: {}}));
vi.mock('@environment/sharedWorkerSupport', () => ({default: false}));
vi.mock('@environment/webpSupport', () => ({default: false}));
vi.mock('@environment/userAgent', async(importOriginal) => ({
  ...await importOriginal<typeof import('@environment/userAgent')>(),
  IS_SAFARI: false
}));

import apiManagerProxy from '@lib/apiManagerProxy';

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
  workerState.instances.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(['worker-source fetch', 'proxy-URL request'] as const)('cleans up an attached worker after a %s failure before retrying', async(failureStage) => {
  workerState.instances.length = 0;
  vi.stubGlobal('Worker', workerState.TestWorker);
  const messagePort = new TestSuperMessagePort();
  const invokeVoid = vi.fn();
  const createProxyWorkerURLs = vi.fn();
  const failedWorkerPort = {close: vi.fn()} as unknown as MessagePort;
  const fetchError = new Error('worker source fetch failed');
  const attachedWorkers: Array<SharedWorker | globalThis.Worker> = [];

  vi.stubGlobal('fetch', vi.fn(async() => {
    messagePort.emitPort(failedWorkerPort);
    if(failureStage === 'worker-source fetch') throw fetchError;
    return {text: async() => ''};
  }));
  if(failureStage === 'proxy-URL request') createProxyWorkerURLs.mockRejectedValueOnce(fetchError);

  const proxy = Object.create(Object.getPrototypeOf(apiManagerProxy)) as any;
  proxy.attachWorkerToPort = (worker: SharedWorker | globalThis.Worker, superMessagePort: TestSuperMessagePort) => {
    attachedWorkers.push(worker);
    superMessagePort.attachPort((worker as SharedWorker).port || worker);
  };
  proxy.invoke = (method: string, params: unknown) => {
    if(method === 'createProxyWorkerURLs') return createProxyWorkerURLs(params);
    throw new Error(`unexpected API manager invocation: ${method}`);
  };
  proxy.invokeVoid = invokeVoid;

  const createWorker = () => new (window as any).Worker(new URL('/assets/lottie.worker.js', location.href), {type: 'module'});
  const registration = {
    type: 'lottie',
    createWorker,
    superMessagePort: messagePort as any
  };

  await expect(proxy.registerThreadedWorker(registration)).rejects.toBe(fetchError);
  expect(messagePort.attached).toEqual([]);
  expect(messagePort.detached).toHaveLength(1);
  expect(messagePort.portListenerCount).toBe(0);
  expect((attachedWorkers[0] as globalThis.Worker & {terminated: boolean}).terminated).toBe(true);
  expect((failedWorkerPort as any).close).toHaveBeenCalledOnce();
  expect(invokeVoid).not.toHaveBeenCalled();

  const retryWorkerPort = {close: vi.fn()} as unknown as MessagePort;
  vi.stubGlobal('fetch', vi.fn(async() => {
    messagePort.emitPort(retryWorkerPort);
    return {text: async() => ''};
  }));
  createProxyWorkerURLs.mockImplementation(() => {
    expect(invokeVoid).not.toHaveBeenCalled();
    return Promise.resolve(['original-worker.js', 'proxy-worker.js']);
  });

  await proxy.registerThreadedWorker(registration);
  expect(messagePort.portListenerCount).toBe(1);
  expect(invokeVoid).toHaveBeenCalledOnce();
  expect(invokeVoid).toHaveBeenCalledWith('threadedPort', 'lottie', undefined, [retryWorkerPort]);
});
