import type LazyLoadQueueIntersector from '@components/lazyLoadQueueIntersector';
import type {Middleware} from '@helpers/middleware';
import {hasLoadedURL} from '@helpers/dom/loadedUrlCache';
import pause from '@helpers/schedulers/pause';

// The first screen is requested at once. A queue runs eight loads at a time, so past it each load
// holds its slot for 240 ms: about 33 requests a second however fast the picker is scrolled. On the
// 256 MiB fixture a flick through every category killed the renderer at unpaced speed and at 67 a
// second (1 of 8), and did not at this rate (0 of 8).
export const FIRST_SCREEN_REQUESTS = 40;
export const SLOT_HOLD_MS = 240;
const started = new WeakMap<object, number>();

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
          const count = (started.get(queue) ?? 0) + 1;
          started.set(queue, count);
          return count > FIRST_SCREEN_REQUESTS ? pause(SLOT_HOLD_MS) : Promise.resolve();
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
