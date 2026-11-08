import {bindActiveWindowListener, getAppWindow} from '@helpers/appWindow';
import apiManagerProxy from '@lib/apiManagerProxy';
import lottieMessagePort from '@lib/lottie/lottieMessagePort';
import SHOULD_RENDER_OFFSCREEN from '@lib/lottie/shouldRenderOffscreen';
import LottieWorkerURL from './tlottie.worker.ts?worker&url';

let loadPromise: Promise<void> | undefined;

export function registerLottieWorkers() {
  if(loadPromise) return loadPromise;

  const promise = (async() => {
    await apiManagerProxy.registerThreadedWorker({
      type: 'lottie',
      workerUrl: () => LottieWorkerURL,
      superMessagePort: lottieMessagePort
    });

    if(SHOULD_RENDER_OFFSCREEN) {
      // hidden-tab belt: SharedWorker timers are NOT tab-throttled - fully pause free-run clocks while
      // hidden. Follow the active window: while popped out into a Document PiP window the PiP stays
      // visible, so the players must keep running even though the tab we left is hidden.
      bindActiveWindowListener((w) => w.document, 'visibilitychange', () => {
        lottieMessagePort.suspendAllTabPlayers(getAppWindow().document.hidden);
      });
    }
  })();

  return loadPromise = promise.catch((error) => {
    loadPromise = undefined;
    throw error;
  });
}
