import type LazyLoadQueueIntersector from '@components/lazyLoadQueueIntersector';
import type {Middleware} from '@helpers/middleware';
import {hasLoadedURL} from '@helpers/dom/loadedUrlCache';

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
          return Promise.resolve();
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
