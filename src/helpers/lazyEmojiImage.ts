/**
 * The emoji picker mounts hundreds of emoji images at once. `loading="lazy"` does not
 * hold them back here (all of them are requested as soon as the picker opens), and the
 * burst of cold image loads kills the renderer in the real-client fixture. The image is
 * therefore created without a `src` and only gets it once it is near the viewport.
 */
let observer: IntersectionObserver | undefined;

function load(image: HTMLImageElement) {
  const src = image.dataset.src;
  if(src === undefined) {
    return;
  }

  delete image.dataset.src;
  image.src = src;
}

export default function observeLazyEmojiImage(image: HTMLImageElement) {
  if(image.dataset.src === undefined) {
    return;
  }

  if(typeof(IntersectionObserver) === 'undefined') {
    load(image);
    return;
  }

  observer ??= new IntersectionObserver((entries) => {
    for(const entry of entries) {
      if(!entry.isIntersecting) {
        continue;
      }

      observer.unobserve(entry.target);
      load(entry.target as HTMLImageElement);
    }
  }, {rootMargin: '100px'});

  observer.observe(image);
}

export {load as loadLazyEmojiImage};
