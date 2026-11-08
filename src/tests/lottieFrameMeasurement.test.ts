import {expect, it} from 'vitest';
import type {Locator, Page} from '@playwright/test';
import {PNG} from 'pngjs';
import {waitUntilOnScreen} from '../../e2e/lottieFrameMeasurement';

it('samples the timestamp after the screenshot observes rendered pixels', async() => {
  const events: string[] = [];
  const png = new PNG({width: 4, height: 4});
  const data = png.data;
  for(let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 0;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  data[0] = 0;

  const page = {
    evaluate: async() => {
      events.push('timestamp');
      return 42;
    }
  } as unknown as Page;
  const locator = {
    screenshot: async() => {
      events.push('screenshot');
      return PNG.sync.write(png);
    }
  } as unknown as Locator;

  await expect(waitUntilOnScreen(page, locator, 100)).resolves.toBe(42);
  expect(events).toEqual(['screenshot', 'timestamp']);
});
