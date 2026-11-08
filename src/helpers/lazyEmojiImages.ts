import type LazyLoadQueueIntersector from '@components/lazyLoadQueueIntersector';
import type {Middleware} from '@helpers/middleware';
import {hasLoadedURL} from '@helpers/dom/loadedUrlCache';
import pause from '@helpers/schedulers/pause';

// A burst of up to 40 loads is requested at once (the first screen, or a view after the queue has been
// quiet). A queue runs eight loads at a time, so past a burst each load holds its slot for 240 ms: about
// 33 requests a second however fast the picker is scrolled. On the 256 MiB fixture a flick through every
// category killed the renderer at unpaced speed and at 67 a second (1 of 8), and did not at this rate.
export const BURST_REQUESTS = 40;
export const SLOT_HOLD_MS = 240;
export const QUIET_MS = 500;
const bursts = new WeakMap<object, {count: number, lastStart: number}>();

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
          const burst = bursts.get(queue) ?? {count: 0, lastStart: 0};
          bursts.set(queue, burst);
          if(now - burst.lastStart > QUIET_MS) burst.count = 0;
          burst.lastStart = now;
          return ++burst.count > BURST_REQUESTS ? pause(SLOT_HOLD_MS) : Promise.resolve();
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
