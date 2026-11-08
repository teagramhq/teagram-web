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

test.each(['worker-source fetch', 'proxy-URL request', 'second worker attachment'] as const)('cleans up registration after a %s failure before retrying', async(failureStage) => {
  workerState.instances.length = 0;
  vi.stubGlobal('Worker', workerState.TestWorker);
  const messagePort = new TestSuperMessagePort();
  const invokeVoid = vi.fn();
  const createProxyWorkerURLs = vi.fn();
  const registrationError = new Error(`${failureStage} failed`);
  const earlyPort = {close: vi.fn()} as unknown as MessagePort;
  const attachedWorkers: Array<SharedWorker | globalThis.Worker> = [];
  let failWorkerSourceFetch = failureStage === 'worker-source fetch';
  let failSecondAttachment = failureStage === 'second worker attachment';

  vi.stubGlobal('fetch', vi.fn(async() => {
    expect(attachedWorkers).toHaveLength(0);
    expect(messagePort.portListenerCount).toBe(0);
    if(failWorkerSourceFetch) {
      failWorkerSourceFetch = false;
      messagePort.emitPort(earlyPort);
      expect(invokeVoid).not.toHaveBeenCalled();
      throw registrationError;
    }
    return {text: async() => ''};
  }));
  if(failureStage === 'proxy-URL request') createProxyWorkerURLs.mockRejectedValueOnce(registrationError);

  const proxy = Object.create(Object.getPrototypeOf(apiManagerProxy)) as any;
  proxy.attachWorkerToPort = (worker: SharedWorker | globalThis.Worker, superMessagePort: TestSuperMessagePort) => {
    attachedWorkers.push(worker);
    superMessagePort.attachPort((worker as SharedWorker).port || worker);
    if(failSecondAttachment && attachedWorkers.length === 1) messagePort.emitPort(earlyPort);
    if(failSecondAttachment && attachedWorkers.length === 2) throw registrationError;
  };
  proxy.invoke = (method: string, params: unknown) => {
    if(method === 'createProxyWorkerURLs') {
      expect(attachedWorkers).toHaveLength(0);
      expect(messagePort.portListenerCount).toBe(0);
      return createProxyWorkerURLs(params);
    }
    throw new Error(`unexpected API manager invocation: ${method}`);
  };
  proxy.invokeVoid = invokeVoid;

  const workerUrl = () => new URL('/assets/lottie.worker.js', location.href);
  const registration = {
    type: 'lottie',
    workerUrl,
    superMessagePort: messagePort as any
  };

  if(failureStage === 'second worker attachment') {
    createProxyWorkerURLs.mockResolvedValueOnce(['original-worker.js', 'proxy-worker.js']);
  }

  await expect(proxy.registerThreadedWorker(registration)).rejects.toBe(registrationError);
  expect(messagePort.attached).toEqual([]);
  expect(messagePort.detached).toHaveLength(failureStage === 'second worker attachment' ? 2 : 0);
  expect(messagePort.portListenerCount).toBe(0);
  expect(attachedWorkers).toHaveLength(failureStage === 'second worker attachment' ? 2 : 0);
  expect(attachedWorkers.every((worker) => (worker as globalThis.Worker & {terminated: boolean}).terminated)).toBe(true);
  expect(invokeVoid).not.toHaveBeenCalled();

  const retryWorkerPort = {close: vi.fn()} as unknown as MessagePort;
  failSecondAttachment = false;
  attachedWorkers.length = 0;
  createProxyWorkerURLs.mockImplementation(() => {
    expect(invokeVoid).not.toHaveBeenCalled();
    return Promise.resolve(['original-worker.js', 'proxy-worker.js']);
  });

  await proxy.registerThreadedWorker(registration);
  expect(createProxyWorkerURLs).toHaveBeenLastCalledWith({
    originalUrl: new URL('/assets/lottie.worker.js', location.href).toString(),
    blob: expect.any(Blob),
    type: 'lottie'
  });
  expect(messagePort.portListenerCount).toBe(1);
  messagePort.emitPort(retryWorkerPort);
  expect(invokeVoid).toHaveBeenCalledOnce();
  expect(invokeVoid).toHaveBeenCalledWith('threadedPort', 'lottie', undefined, [retryWorkerPort]);

  const latePort = {close: vi.fn()} as unknown as MessagePort;
  messagePort.emitPort(latePort);
  expect(invokeVoid).toHaveBeenCalledTimes(2);
  expect(invokeVoid).toHaveBeenLastCalledWith('threadedPort', 'lottie', undefined, [latePort]);
});
