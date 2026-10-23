import {test, expect} from '@playwright/test';

test('keeps static reaction artwork inside its reaction chip while retaining animated sizing', async({page}) => {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as any).apiManagerProxy?.getReaction === 'function',
    null,
    {timeout: 30_000}
  );

  const results = await page.evaluate(async() => {
    const apiManagerProxyPath = '/src/lib/apiManagerProxy.ts';
    const reactionElementPath = '/src/components/chat/reaction.ts';
    const [{default: apiManagerProxy}, {default: ReactionElement}] = await Promise.all([
      import(/* @vite-ignore */ apiManagerProxyPath),
      import(/* @vite-ignore */ reactionElementPath)
    ]);
    const proxy = apiManagerProxy as any;
    const originalGetReaction = proxy.getReaction;
    const output: Array<{emoji: string, mimeType: string, wrapperWidth: number, imageWidth: number, classes: string[]}> = [];

    const reactions = [
      {emoji: '❤', mimeType: 'image/webp'},
      {emoji: '👍', mimeType: 'image/webp'},
      {emoji: '🔥', mimeType: 'image/webp'},
      {emoji: '🎉', mimeType: 'image/png'},
      {emoji: '✨', mimeType: 'application/x-tgsticker'}
    ];

    try {
      for(const {emoji, mimeType} of reactions) {
        const doc = {
          _: 'document',
          id: '1',
          access_hash: '1',
          file_reference: new Uint8Array(),
          date: 0,
          mime_type: mimeType,
          size: 1,
          dc_id: 1,
          attributes: [] as never[]
        };
        proxy.getReaction = () => ({
          _: 'availableReaction',
          reaction: emoji,
          title: emoji,
          pFlags: {},
          static_icon: doc,
          center_icon: doc
        });

        const element = new ReactionElement();
        element.init('block' as any, (() => true) as any);
        (element as any).reactionCount = {reaction: {_: 'reactionEmoji', emoticon: emoji}, count: 1};
        (element as any).renderDoc = () => {};
        element.render();
        window.document.body.append(element);

        const image = window.document.createElement('img');
        image.className = 'media-sticker';
        image.style.cssText = 'width:22px;height:22px;';
        element.stickerContainer.append(image);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

        output.push({
          emoji,
          mimeType,
          wrapperWidth: parseFloat(getComputedStyle(element.stickerContainer).width),
          imageWidth: parseFloat(getComputedStyle(image).width),
          classes: Array.from(element.stickerContainer.classList)
        });
        element.remove();
      }
    } finally {
      proxy.getReaction = originalGetReaction;
    }

    return output;
  });

  for(const result of results.filter((item) => item.mimeType.startsWith('image/'))) {
    expect(result.classes, `${result.emoji} static image should use the static sizing path`).toContain('is-static');
    expect(result.imageWidth, `${result.emoji} image should not exceed its ${result.wrapperWidth}px wrapper`).toBeLessThanOrEqual(result.wrapperWidth);
  }

  const animated = results.find((item) => item.mimeType === 'application/x-tgsticker');
  expect(animated?.classes, 'animated reaction should keep the regular sizing path').toContain('is-regular');
});
