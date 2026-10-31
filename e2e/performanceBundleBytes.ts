import {scenarioBundleBytes} from '../scripts/performance/policy.mjs';

export type BundleResource = Pick<PerformanceResourceTiming, 'name' | 'startTime' | 'decodedBodySize'>;

export type BundleRequest = {url: () => string};

export type BundleRequestTracker = {
  requestStarted: (request: BundleRequest) => void,
  requestFinished: (request: BundleRequest) => void,
  requestFailed: (request: BundleRequest) => void,
  workerCreated: (url: string) => void,
  waitForIdle: (quietMs: number, timeoutMs: number) => Promise<void>
};

export function sumBundleBytes(resources: BundleResource[], origin: string, startedAtMs: number, endedAtMs: number, previouslyLoadedUrls: string[] = []) {
  const inWindow = resources.filter((entry) => entry.startTime >= startedAtMs && entry.startTime <= endedAtMs);
  return scenarioBundleBytes(inWindow, origin, startedAtMs, previouslyLoadedUrls);
}

export function createBundleRequestTracker(origin: string): BundleRequestTracker {
  const pendingRequests = new Set<BundleRequest>();
  const listeners = new Set<() => void>();
  let lastActivityAt = Date.now();
  let lastMatchedUrl = '';

  const notify = () => listeners.forEach((listener) => listener());
  const matchesBundle = (request: BundleRequest) => {
    try {
      const url = new URL(request.url());
      return (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.origin === origin &&
        /\.(js|css)(?:[?#]|$)/i.test(request.url());
    } catch{
      return false;
    }
  };
  const requestStarted = (request: BundleRequest) => {
    if(!matchesBundle(request)) return;
    pendingRequests.add(request);
    lastActivityAt = Date.now();
    lastMatchedUrl = request.url();
    notify();
  };
  const requestFinished = (request: BundleRequest) => {
    if(!pendingRequests.delete(request)) return;
    lastActivityAt = Date.now();
    lastMatchedUrl = request.url();
    notify();
  };
  const workerCreated = (url: string) => {
    const request = [...pendingRequests].find((pendingRequest) => pendingRequest.url() === url);
    if(request) requestFinished(request);
  };
  const waitForIdle = (quietMs: number, timeoutMs: number) => new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const timers: {
      quiet?: ReturnType<typeof setTimeout>,
      timeout?: ReturnType<typeof setTimeout>
    } = {};

    const finish = (error?: Error) => {
      if(timers.quiet) clearTimeout(timers.quiet);
      if(timers.timeout) clearTimeout(timers.timeout);
      listeners.delete(check);
      if(error) reject(error);
      else resolve();
    };
    const check = () => {
      if(timers.quiet) {
        clearTimeout(timers.quiet);
        timers.quiet = undefined;
      }
      if(pendingRequests.size) return;
      const remainingQuietMs = quietMs - (Date.now() - lastActivityAt);
      if(remainingQuietMs <= 0) {
        finish();
        return;
      }
      timers.quiet = setTimeout(check, remainingQuietMs);
    };

    listeners.add(check);
    timers.timeout = setTimeout(() => {
      const pendingUrls = [...pendingRequests].map((request) => request.url());
      const pending = pendingUrls.length ? pendingUrls.join(', ') : 'none';
      const lastRequest = lastMatchedUrl || 'none';
      finish(new Error(`Same-origin JavaScript and CSS requests did not settle within ${timeoutMs} ms; pending: ${pending}; last matched: ${lastRequest}; elapsed ${Date.now() - startedAt} ms`));
    }, timeoutMs);
    check();
  });

  return {
    requestStarted,
    requestFinished,
    requestFailed: requestFinished,
    workerCreated,
    waitForIdle
  };
}
