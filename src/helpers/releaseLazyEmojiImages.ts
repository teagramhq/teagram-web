import type LazyLoadQueueIntersector from '@components/lazyLoadQueueIntersector';

// An image the queue still holds keeps its node and observer target alive for as long as the
// category's middleware does, so one that is replaced or dropped has to be deleted from it
export default function releaseLazyEmojiImages(
  parent: HTMLElement,
  queue: Pick<LazyLoadQueueIntersector, 'delete'> | undefined,
  except?: Element
) {
  if(!queue) {
    return;
  }

  parent.querySelectorAll('img').forEach((image) => {
    if(image !== except) {
      queue.delete({div: image});
    }
  });
}
