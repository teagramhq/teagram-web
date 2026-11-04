export type StickerPackType = 'stickers' | 'emoji';
export type StickerPackRejectionReason = 'too_large' | 'too_many' | 'unsupported_format';
export type StickerPackRejectedFile = {name: string, reason: StickerPackRejectionReason};

export const SHORT_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export const STICKER_FILE_LIMITS = {
  webp: {size: 512 * 1024, mimeType: 'image/webp'},
  tgs: {size: 64 * 1024, mimeType: 'application/x-tgsticker'},
  webm: {size: 256 * 1024, mimeType: 'video/webm'}
} as const;

export type StickerFileExtension = keyof typeof STICKER_FILE_LIMITS;

declare const validatedStickerPackFilesBrand: unique symbol;
export type ValidatedStickerPackFiles = File[] & {[validatedStickerPackFilesBrand]: true};

export function getStickerFileExtension(name: string): StickerFileExtension | undefined {
  const match = /\.([^.]+)$/.exec(name);
  const extension = match?.[1].toLowerCase();
  return extension && Object.prototype.hasOwnProperty.call(STICKER_FILE_LIMITS, extension) ? extension as StickerFileExtension : undefined;
}

export function getBasename(name: string) {
  return name.replace(/\\/g, '/').split('/').pop() || '';
}

export function getStickerFileMimeType(name: string) {
  const extension = getStickerFileExtension(name);
  if(!extension) throw new Error('Unsupported sticker file format');
  return STICKER_FILE_LIMITS[extension].mimeType;
}

export function getStickerPackMaxCount(type: StickerPackType) {
  return type === 'emoji' ? 200 : 120;
}
