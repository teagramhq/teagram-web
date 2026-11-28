import type {FragmentLink} from '@lib/fragmentLink';

// The encoder is its own chunk: link builders run on a click or a popup open, never on the startup path.
export function buildFragmentLinkURL(link: FragmentLink) {
  return import('@lib/fragmentLink').then(({createFragmentLinkURL}) => createFragmentLinkURL(link));
}
