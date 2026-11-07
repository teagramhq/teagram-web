import DEBUG from '@config/debug';
import {makeWorkerURL} from '@helpers/setWorkerProxy';
import {rewritePrivateWorkerImports} from '@helpers/createPrivateWorkerBlobURL';
import IS_SHARED_WORKER_SUPPORTED from '@environment/sharedWorkerSupport';
import {IS_SAFARI} from '@environment/userAgent';
import type {ThreadedWorkerEvents} from '@lib/mainWorker/mainMessagePort';
import type SuperMessagePort from '@lib/superMessagePort';

type SuperPort = SuperMessagePort<ThreadedWorkerEvents, ThreadedWorkerEvents, any>;

type RegisterOptions = {
  createWorker: () => SharedWorker | Worker,
  superMessagePort: SuperPort,
  attachWorkerToPort: (worker: SharedWorker | Worker) => void,
  createProxyWorkerURLs: (params: {originalUrl: string, blob: Blob, type: 'lottie'}) => Promise<string[]>,
  forwardPort: (port: MessagePort) => void
};

export default async function registerThreadedLottieWorker({
  createWorker: createOriginalWorker,
  superMessagePort,
  attachWorkerToPort,
  createProxyWorkerURLs,
  forwardPort
}: RegisterOptions) {
  const get = (url: string) => {
    return fetch(url).then((response) => response.text()).then((text) => {
      const pathnameSplitted = location.pathname.split('/');
      pathnameSplitted[pathnameSplitted.length - 1] = '';
      const pre = location.origin + pathnameSplitted.join('/');
      text = rewritePrivateWorkerImports(text, pre);

      return new Blob([text], {type: 'application/javascript'});
    });
  };

  const workerHandler = {
    construct(target: any, args: any): any {
      return {
        url: makeWorkerURL(args[0]).toString()
      };
    }
  };

  const originals = [
    Worker,
    typeof(SharedWorker) !== 'undefined' && SharedWorker
  ].filter(Boolean);
  const initialWorker = (() => {
    originals.forEach((worker) => window[worker.name as any] = new Proxy(worker, workerHandler));
    try {
      return createOriginalWorker();
    } finally {
      originals.forEach((worker) => window[worker.name as any] = worker as any);
    }
  })();

  const originalUrl = (initialWorker as any).url;
  const constructor = IS_SHARED_WORKER_SUPPORTED && !IS_SAFARI ? SharedWorker : Worker;
  const createWorker = (url: string) => new constructor(url, {type: 'module'});

  const workers: Array<SharedWorker | Worker> = [];
  const pendingPorts: MessagePort[] = [];
  let canForwardPorts = false;
  const onPort = (_payload: void, _source: MessageEventSource, event: MessageEvent) => {
    const port = event.ports[0];
    if(canForwardPorts) {
      forwardPort(port);
    } else {
      pendingPorts.push(port);
    }
  };
  superMessagePort.addEventListener('port', onPort);

  try {
    const firstWorker = createWorker(originalUrl);
    workers.push(firstWorker);
    attachWorkerToPort(firstWorker);

    const blob = await get(originalUrl);
    const urls = await createProxyWorkerURLs({originalUrl, blob, type: 'lottie'});
    for(const url of urls.slice(1)) {
      const worker = createWorker(url);
      workers.push(worker);
      attachWorkerToPort(worker);
    }

    if(DEBUG) {
      console.log('Workers URLs', 'lottie', urls);
    }

    canForwardPorts = true;
    for(const port of pendingPorts) {
      forwardPort(port);
    }
    pendingPorts.length = 0;
  } catch(error) {
    superMessagePort.removeEventListener('port', onPort);
    pendingPorts.forEach((port) => port.close());
    workers.forEach((worker) => {
      const port = (worker as SharedWorker).port || worker as any;
      superMessagePort.detachPort(port);
      if(port === worker) (worker as Worker).terminate();
    });
    throw error;
  }
}
