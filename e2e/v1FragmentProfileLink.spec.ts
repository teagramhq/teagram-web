import {expect, test} from '@playwright/test';

test('dispatches a v1 profile link in the browser runtime', async({page}) => {
  await page.goto('/?noWorker=1&noServiceWorker=1#~QQHDpNc', {waitUntil: 'domcontentloaded'});

  const dispatch = await page.evaluate(async() => {
    const moduleUrl = new URL('/src/lib/fragmentLinkDecode.ts', location.origin).href;
    const {dispatchDefaultServerFragmentLink} = await import(moduleUrl);
    const handled: unknown[] = [];
    const didHandle = dispatchDefaultServerFragmentLink(location.hash, (link: unknown) => handled.push(link), true);
    return {didHandle, handled};
  });

  expect(dispatch).toEqual({didHandle: true, handled: [{type: 1, username: 'alice'}]});
});
