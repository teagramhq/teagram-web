import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Page} from '@playwright/test';
import {waitForDeferredUiAndSnapshotRequests} from '../../e2e/performanceDeferredUi';

function makePage(): Page {
  return {
    waitForFunction: async(predicate: () => boolean) => {
      await new Promise<void>((resolve) => {
        const check = () => {
          if(predicate()) {
            resolve();
          } else {
            setTimeout(check, 1);
          }
        };
        check();
      });
    },
    locator: () => ({
      getAttribute: async() => document.body.getAttribute('data-deferred-ui')
    })
  } as unknown as Page;
}

describe('deferred UI performance capture boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete document.body.dataset.deferredUi;
  });

  it('snapshots request totals only after deferred chunks settle', async() => {
    document.body.dataset.deferredUi = 'pending';
    const requests = {value: 1};
    setTimeout(() => {
      requests.value = 4;
      document.body.dataset.deferredUi = 'ready';
    }, 10);

    await expect(waitForDeferredUiAndSnapshotRequests(makePage(), requests)).resolves.toBe(4);
  });

  it('rejects capture when deferred UI failed to load', async() => {
    document.body.dataset.deferredUi = 'failed';

    await expect(waitForDeferredUiAndSnapshotRequests(makePage(), {value: 1})).rejects.toThrow('deferred UI loading failed');
  });
});
