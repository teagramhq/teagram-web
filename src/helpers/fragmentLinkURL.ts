import {getActiveServerHost, getRuntimeServerId} from '@config/serverContext';
import type {FragmentLink} from '@lib/fragmentLink';

// The encoder is its own chunk: link builders run on a click or a popup open, never on the startup path.
export function buildFragmentLinkURL(link: FragmentLink) {
  const isDefaultServer = getRuntimeServerId() === 'default';
  const host = isDefaultServer ? undefined : getActiveServerHost();
  if(!isDefaultServer && !host) return Promise.reject(new Error('Active server host is unavailable'));
  return import('@lib/fragmentLink').then(({createFragmentLinkURL}) => createFragmentLinkURL(link, host));
}
