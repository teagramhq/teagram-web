import {test, expect} from '@playwright/test';
import {readdirSync} from 'fs';
import {resolve} from 'path';
import {LOTTIE_FRAME_BG_CSS, waitUntilOnScreen} from './lottieFrameMeasurement';

const TGS_DIR = resolve(__dirname, '..', 'public', 'assets', 'tgs');
// ReactionGeneric is the colourless "generic reaction" template: it renders fully transparent
// until the reactions UI applies a tint, so there's nothing to detect when rendered standalone.
const SKIP = new Set(['ReactionGeneric.json']);
const STICKERS = readdirSync(TGS_DIR).filter((f) => f.endsWith('.json') && !SKIP.has(f)).sort();

const SIZE = 140;
// The host container is painted opaque magenta; a transferControlToOffscreen placeholder canvas
// can't be read back, so we detect rendering by screenshotting and counting pixels that differ
// from the background. A blank/transparent canvas leaves the box fully magenta.
const BG_CSS = LOTTIE_FRAME_BG_CSS;

test.beforeEach(async({page}) => {
  await page.goto('/');
  // app boot mounts lottieLoader on window (MOUNT_CLASS_TO = ctx) and connects the worker
  await page.waitForFunction(
    () => typeof (window as any).lottieLoader?.loadAnimationFromURL === 'function',
    null,
    {timeout: 30_000}
  );
});

for(const file of STICKERS) {
  test(`renders ${file} on screen`, async({page}) => {
    const url = '/assets/tgs/' + file;

    // render through the real app path (offscreen 'canvas' player + SharedWorker), and stamp the
    // player's own firstFrame event so we can compare it against the real on-screen appearance
    await page.evaluate(async({url, bg, size}) => {
      const w = window as any;
      const container = document.createElement('div');
      container.id = 'lottie-under-test';
      container.style.cssText =
        `position:fixed;top:0;left:0;width:${size}px;height:${size}px;z-index:2147483647;background:${bg};`;
      document.body.append(container);

      w.__t0 = performance.now();
      w.__firstFrameAt = undefined;
      const player = await w.lottieLoader.loadAnimationFromURL(
        {container, width: size, height: size, group: 'none', loop: true, autoplay: true, name: url},
        url
      );
      if(player.hasRenderedFirstFrame) w.__firstFrameAt = performance.now();
      else player.addEventListener('firstFrame', () => { w.__firstFrameAt = performance.now(); });
    }, {url, bg: BG_CSS, size: SIZE});

    const onScreenAt = await waitUntilOnScreen(page, page.locator('#lottie-under-test'), 20_000);

    const {t0, firstFrameAt} = await page.evaluate(() => ({
      t0: (window as any).__t0 as number,
      firstFrameAt: (window as any).__firstFrameAt as number | undefined
    }));
    await page.evaluate(() => document.getElementById('lottie-under-test')?.remove());

    expect(onScreenAt, `${file} never produced pixels on screen`).not.toBeNull();

    const onScreenMs = (onScreenAt! - t0).toFixed(0);
    const firstFrameMs = firstFrameAt != null ? (firstFrameAt - t0).toFixed(0) : '?';
    const gapMs = firstFrameAt != null ? (onScreenAt! - firstFrameAt).toFixed(0) : '?';
    // the gap is the whole point: how long after the player says "firstFrame" the frame is actually
    // visible. A large/variable gap is exactly the window the thumb-retire was racing.
    console.log(`[lottie] ${file.padEnd(40)} firstFrame=+${firstFrameMs}ms  onScreen=+${onScreenMs}ms  gap=${gapMs}ms`);
  });
}
