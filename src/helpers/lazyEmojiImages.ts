import type LazyLoadQueueIntersector from '@components/lazyLoadQueueIntersector';
import type {Middleware} from '@helpers/middleware';
import {hasLoadedURL} from '@helpers/dom/loadedUrlCache';
import pause from '@helpers/schedulers/pause';

// No more than 40 loads start within any 1.5 s window without a hold. A queue runs eight loads at a time,
// so once the window is full each load holds its slot for 240 ms. That keeps the long-run rate at or below
// about 33 requests a second whatever the scroll cadence: a window is a hard bound, unlike a reset after a
// quiet gap, which a page of new emoji every half second would keep reopening. On the 256 MiB fixture a
// cold flick through every category killed the renderer at unpaced speed and at 67 a second (1 of 8).
export const BURST_REQUESTS = 40;
export const WINDOW_MS = 1500;
export const SLOT_HOLD_MS = 240;
const starts = new WeakMap<object, number[]>();

/**
 * Hands the picker's emoji images to the dropdown's load queue: an image gets its src when it is near
 * view, and is dropped from the queue when the category's middleware is gone.
 */
export default function createLazyEmojiImages(
  queue: Pick<LazyLoadQueueIntersector, 'push' | 'delete'>,
  middleware: Middleware
) {
  return {
    // every path either sets the src or queues the image, so an emoji is never left blank
    load(image: HTMLImageElement, url: string) {
      if(hasLoadedURL(url)) {
        image.src = url;
        return;
      }

      // the queue starts the next image only when this one resolves, so resolve once the request is
      // out instead of after the decode
      queue.push({
        div: image,
        middleware,
        load: () => {
          image.src = url;
          const now = Date.now();
          const recent = (starts.get(queue) ?? []).filter((time) => now - time < WINDOW_MS);
          starts.set(queue, recent);
          recent.push(now);
          return recent.length > BURST_REQUESTS ? pause(SLOT_HOLD_MS) : Promise.resolve();
        }
      });
    },

    // an image the queue still holds keeps its node and observer target alive for as long as the
    // middleware does, so one that is replaced or dropped has to be deleted from it
    release(parent: HTMLElement, except?: Element) {
      parent.querySelectorAll('img').forEach((image) => {
        if(image !== except) {
          queue.delete({div: image});
        }
      });
    }
  };
}
