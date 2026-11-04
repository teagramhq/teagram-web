const SHORT_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
let stickerSetLinkPrefix: string | undefined;

export function setStickerSetLinkPrefix(prefix: string) {
  try {
    const url = new URL(prefix);
    stickerSetLinkPrefix = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch(err) {
    stickerSetLinkPrefix = undefined;
  }
}

export function getStickerSetLinkPrefix() {
  return stickerSetLinkPrefix;
}

export function createStickerSetShareLink(prefix: string, shortName: string, isEmoji: boolean) {
  if(!SHORT_NAME_PATTERN.test(shortName)) throw new Error('Invalid sticker set short name');

  const base = new URL(prefix);
  if(
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('Invalid sticker set link prefix');
  }

  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  base.pathname = `${basePath}${isEmoji ? 'addemoji' : 'addstickers'}/${shortName}`;
  return base.toString();
}

export function parseStickerSetShareLink(value: string, prefix?: string): {shortName: string, isEmoji: boolean} | undefined {
  let link: URL,
    base: URL;
  try {
    if(!prefix) return;
    link = new URL(value);
    base = new URL(prefix);
  } catch(err) {
    return;
  }

  if(
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    link.origin !== base.origin ||
    link.username ||
    link.password ||
    link.search ||
    link.hash ||
    base.search ||
    base.hash
  ) {
    return;
  }

  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if(!link.pathname.startsWith(basePath)) return;

  const match = /^(addstickers|addemoji)\/([A-Za-z0-9_]{1,64})$/.exec(link.pathname.slice(basePath.length));
  if(!match) return;

  return {shortName: match[2], isEmoji: match[1] === 'addemoji'};
}

export async function processInitialStickerSetShareLink(
  href: string,
  configPromise: Promise<{me_url_prefix: string}>,
  onStickerSet: (stickerSet: {shortName: string, isEmoji: boolean}) => void
) {
  let config: {me_url_prefix: string};
  try {
    config = await configPromise;
  } catch(err) {
    return;
  }

  setStickerSetLinkPrefix(config.me_url_prefix);
  const stickerSet = parseStickerSetShareLink(href, config.me_url_prefix);
  if(stickerSet) onStickerSet(stickerSet);
}
