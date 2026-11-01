import type {Locator} from '@playwright/test';

export async function startMeasurementAtClick(target: Locator) {
  await target.evaluate((element) => {
    const perf = (window as any).__teagramPerf as {
      started: number,
      preInteractionMs?: number,
      clickAt?: number
    };
    const armedAt = performance.now();
    const onClick = (event: MouseEvent) => {
      if(!event.composedPath().includes(element)) return;
      document.removeEventListener('click', onClick, true);
      const clickAt = performance.now();
      perf.started = clickAt;
      perf.preInteractionMs = clickAt - armedAt;
      perf.clickAt = clickAt;
    };
    document.addEventListener('click', onClick, true);
  });
}
