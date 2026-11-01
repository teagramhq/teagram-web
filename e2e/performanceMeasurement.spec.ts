import {expect, test} from '@playwright/test';
import {startMeasurementAtClick} from './performanceMeasurement';

test('starts the measured window when the browser dispatches the click', async({page}) => {
  await page.setContent('<button>Open chat</button>');
  await page.evaluate(() => {
    (window as any).__teagramPerf = {started: performance.now()};
  });
  const button = page.getByRole('button', {name: 'Open chat'});
  await startMeasurementAtClick(button);
  await page.waitForTimeout(30);
  await button.click();

  const measurement = await page.evaluate(() => (window as any).__teagramPerf);
  expect(measurement.started).toBeGreaterThan(0);
  expect(measurement.preInteractionMs).toBeGreaterThanOrEqual(30);
  expect(measurement.started).toBe(measurement.clickAt);
});
