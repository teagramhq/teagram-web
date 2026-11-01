import {logger} from '@lib/logger';
import dT from '@helpers/dT';

export function recordPromise<T extends Promise<any>>(
  promise: T,
  description: string,
  log: ReturnType<typeof logger> | Console = console
) {
  if(!(promise instanceof Promise)) {
    return promise;
  }

  const perf = performance.now();
  log.warn(dT(), 'start', description);
  const timeout = setTimeout(() => {
    log.warn(dT(), 'timeout', description, performance.now() - perf);
  }, 1e3);
  void promise.then(
    () => {
      log.warn(dT(), 'end', description, performance.now() - perf);
    },
    (error) => {
      log.error(dT(), 'error', description, error);
    }
  ).finally(() => {
    clearTimeout(timeout);
  }).catch((error) => {
    log.error(dT(), 'error while recording', description, error);
  });

  return promise;
}

export function recordPromiseBound(log: ReturnType<typeof logger> | Console) {
  return (...args: [Parameters<typeof recordPromise>[0], Parameters<typeof recordPromise>[1]]) => {
    return recordPromise(...args, log);
  };
}
