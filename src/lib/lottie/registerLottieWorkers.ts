import {bindActiveWindowListener, getAppWindow} from '@helpers/appWindow';
import apiManagerProxy from '@lib/apiManagerProxy';
import lottieMessagePort from '@lib/lottie/lottieMessagePort';
import SHOULD_RENDER_OFFSCREEN from '@lib/lottie/shouldRenderOffscreen';
import registerThreadedLottieWorker from '@lib/lottie/registerThreadedWorker';

export async function registerLottieWorkers() {
  await registerThreadedLottieWorker({
    createWorker: () => new Worker(
      new URL('./tlottie.worker.ts', import.meta.url),
      {type: 'module'}
    ),
    superMessagePort: lottieMessagePort,
    attachWorkerToPort: (worker) => apiManagerProxy.attachWorkerToPort(worker, lottieMessagePort, 'lottie'),
    createProxyWorkerURLs: (params) => apiManagerProxy.invoke('createProxyWorkerURLs', params),
    forwardPort: (port) => apiManagerProxy.invokeVoid('threadedPort', 'lottie', undefined, [port])
  });

  if(SHOULD_RENDER_OFFSCREEN) {
    // hidden-tab belt: SharedWorker timers are NOT tab-throttled - fully pause free-run clocks while
    // hidden. Follow the active window: while popped out into a Document PiP window the PiP stays
    // visible, so the players must keep running even though the tab we left is hidden.
    bindActiveWindowListener((w) => w.document, 'visibilitychange', () => {
      lottieMessagePort.suspendAllTabPlayers(getAppWindow().document.hidden);
    });
  }
}
