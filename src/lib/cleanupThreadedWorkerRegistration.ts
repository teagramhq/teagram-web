import type SuperMessagePort from '@lib/superMessagePort';

export default function cleanupThreadedWorkerRegistration(
  superMessagePort: SuperMessagePort<any, any, any>,
  workers: Array<SharedWorker | Worker>
) {
  workers.forEach((worker) => {
    superMessagePort.detachPort((worker as SharedWorker).port || worker as any);
    (worker as Worker).terminate?.();
  });
}
