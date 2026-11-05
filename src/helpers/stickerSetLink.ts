import {SHORT_NAME_PATTERN} from '@helpers/stickerPackCommon';
import {logger} from '@lib/logger';

let stickerSetLinkPrefix: string | undefined;
const stickerSetLinkLogger = logger('StickerSetLink');

function parseStickerSetLinkPrefix(prefix: string) {
  try {
    const url = new URL(prefix);
    if(
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) return;
    return url;
  } catch(err) {
    return;
  }
}

export function setStickerSetLinkPrefix(prefix: string) {
  const url = parseStickerSetLinkPrefix(prefix);
  if(!url) {
    stickerSetLinkPrefix = undefined;
    stickerSetLinkLogger.error('Rejected invalid sticker set link prefix', prefix);
    return false;
  }

  stickerSetLinkPrefix = url.toString();
  return true;
}

function getPotentialStickerSetRoute(pathname: string) {
  const match = /\/(addstickers|addemoji)\/([^/]+)$/.exec(pathname);
  return match && SHORT_NAME_PATTERN.test(match[2]) ? match : undefined;
}

export function getStickerSetLinkPrefix() {
  return stickerSetLinkPrefix;
}

export function resolveStickerSetShareLink(value: string) {
  return parseStickerSetShareLink(value, stickerSetLinkPrefix);
}

export function handleStickerSetShareLinkClick(
  value: string,
  masked: boolean,
  onStickerSet: (stickerSet: {shortName: string, isEmoji: boolean}) => void,
  onMasked: () => void
) {
  const stickerSet = resolveStickerSetShareLink(value);
  if(stickerSet) {
    onStickerSet(stickerSet);
  } else if(masked) {
    onMasked();
  }
}

export function createStickerSetShareLink(prefix: string, shortName: string, isEmoji: boolean) {
  if(!SHORT_NAME_PATTERN.test(shortName)) throw new Error('Invalid sticker set short name');

  const base = parseStickerSetLinkPrefix(prefix);
  if(!base) {
    stickerSetLinkLogger.error('Rejected invalid sticker set link prefix', prefix);
    throw new Error('Invalid sticker set link prefix');
  }

  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  base.pathname = `${basePath}${isEmoji ? 'addemoji' : 'addstickers'}/${shortName}`;
  return base.toString();
}

export function parseStickerSetShareLink(value: string, prefix?: string): {shortName: string, isEmoji: boolean} | undefined {
  if(!prefix) return;

  let link: URL;
  try {
    link = new URL(value);
  } catch(err) {
    return;
  }

  const base = parseStickerSetLinkPrefix(prefix);
  if(
    !base ||
    link.origin !== base.origin ||
    link.username ||
    link.password ||
    link.search ||
    link.hash
  ) {
    return;
  }

  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if(!link.pathname.startsWith(basePath)) return;

  const match = /^(addstickers|addemoji)\/([A-Za-z0-9_]{1,64})$/.exec(link.pathname.slice(basePath.length));
  if(!match) return;

  return {shortName: match[2], isEmoji: match[1] === 'addemoji'};
}

export function isPotentialStickerSetShareLink(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch(err) {
    return false;
  }

  if(
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) return false;

  return !!getPotentialStickerSetRoute(url.pathname);
}

export function captureInitialStickerSetShareLink() {
  const href = window.location.href;
  const url = new URL(href);
  const stickerSetLink = isPotentialStickerSetShareLink(href) ? href : undefined;
  if(getPotentialStickerSetRoute(url.pathname)) {
    window.history.replaceState(window.history.state, '', `/${url.search}${url.hash}`);
  }
  return stickerSetLink;
}

export const initialStickerSetShareLink = typeof window === 'undefined' ? undefined : captureInitialStickerSetShareLink();

export async function processInitialStickerSetShareLink(
  href: string,
  configPromise: Promise<{me_url_prefix: string}>,
  onStickerSet: (stickerSet: {shortName: string, isEmoji: boolean}) => void
) {
  if(!isPotentialStickerSetShareLink(href)) return;

  let config: {me_url_prefix: string};
  try {
    config = await configPromise;
  } catch(err) {
    stickerSetLinkLogger.error('Could not load config for initial sticker set link', err);
    throw err;
  }

  if(!setStickerSetLinkPrefix(config.me_url_prefix)) throw new Error('Invalid sticker set link prefix');
  const stickerSet = parseStickerSetShareLink(href, config.me_url_prefix);
  if(stickerSet) onStickerSet(stickerSet);
}
