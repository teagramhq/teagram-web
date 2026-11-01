import type {Locator} from '@playwright/test';

export async function startMeasurementAtClick(target: Locator) {
  await target.evaluate((element) => {
    const perf = (window as any).__teagramPerf as {
      started: number,
      preInteractionMs?: number,
      clickAt?: number
    };
    const armedAt = performance.now();
    element.addEventListener('click', () => {
      const clickAt = performance.now();
      perf.started = clickAt;
      perf.preInteractionMs = clickAt - armedAt;
      perf.clickAt = clickAt;
    }, {capture: true, once: true});
  });
}
