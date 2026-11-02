import type {Page} from '@playwright/test';

type DeferredUiPage = Pick<Page, 'waitForFunction' | 'locator'>;

export async function waitForDeferredUi(page: DeferredUiPage) {
  await page.waitForFunction(() => document.body.dataset.deferredUi !== 'pending', undefined, {timeout: 60_000});
  const deferredUiState = await page.locator('body').getAttribute('data-deferred-ui');
  if(deferredUiState === 'failed') throw new Error('deferred UI loading failed');
}

export async function waitForDeferredUiAndSnapshotRequests(page: DeferredUiPage, requests: {value: number}) {
  await waitForDeferredUi(page);
  return requests.value;
}
