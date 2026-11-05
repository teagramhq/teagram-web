import {getStickerFileExtension, getStickerPackMaxCount, SHORT_NAME_PATTERN, STICKER_FILE_LIMITS} from '@helpers/stickerPackCommon';
import type {StickerPackType, ValidatedStickerPackFiles} from '@helpers/stickerPackCommon';
import {validateStickerPackFiles} from '@helpers/stickerPackImport';
import {MAX_ZIP_TOTAL_SIZE} from '@helpers/stickerPackImportZip';
import {isValidTelegramBotToken, TELEGRAM_BOT_API_ORIGIN} from '@config/telegramBotApi';
import {logger} from '@lib/logger';

const MAX_TELEGRAM_PACK_FILES = 201;
const DEFAULT_STICKER_EMOJI = '🙂';
const telegramStickerPackImportLogger = logger('TelegramStickerPackImport');

const FETCH_OPTIONS: RequestInit = {
  mode: 'cors',
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
  cache: 'no-store',
  redirect: 'error'
};

export type TelegramStickerPackLink = {name: string, type: StickerPackType, source: string};
export type TelegramStickerPackProgress = {current: number, total: number};
export type TelegramStickerPackDownload = {
  title: string,
  type: StickerPackType,
  source: string,
  files: ValidatedStickerPackFiles,
  emojis: string[]
};
export type TelegramStickerPackUploadDetails = Pick<TelegramStickerPackDownload, 'files' | 'type' | 'source' | 'emojis'> & {title: string};
export type TelegramStickerPackUploadOptions = {
  files: ValidatedStickerPackFiles,
  title: string,
  shortName: string,
  isEmoji: boolean,
  software: string,
  emojis: string[]
};

type TelegramSticker = Record<string, unknown>;
type TelegramFile = {file_path: string, file_size?: number};
type TelegramMethod = 'getStickerSet' | 'getCustomEmojiStickers' | 'getFile';

export class TelegramStickerPackImportError extends Error {
  constructor(message: string, public code?: 'network') {
    super(message);
    this.name = 'TelegramStickerPackImportError';
  }
}

function safeErrorName(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name) ? name : 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export {isValidTelegramBotToken};

export function getTelegramStickerPackUploadOptions(
  pack: TelegramStickerPackUploadDetails,
  shortName: string
): TelegramStickerPackUploadOptions {
  return {
    files: pack.files,
    title: pack.title,
    shortName,
    isEmoji: pack.type === 'emoji',
    software: pack.source,
    emojis: pack.emojis
  };
}

export function parseTelegramStickerPackLink(value: string): TelegramStickerPackLink | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch{
    return undefined;
  }

  if(
    url.protocol !== 'https:' ||
    url.origin !== 'https://t.me' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) return undefined;

  const match = /^\/(addstickers|addemoji)\/([A-Za-z0-9_]{1,64})$/.exec(url.pathname);
  if(!match) return undefined;

  const [, route, name] = match;
  const type = route === 'addemoji' ? 'emoji' : 'stickers';
  return {name, type, source: `https://t.me/${route}/${name}`};
}

function safeDescription(description: string, token: string) {
  return description
  .split(token).join('[redacted]')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 500);
}

function assertTelegramResponse(response: Response) {
  if(response.redirected) {
    throw new TelegramStickerPackImportError('Telegram returned a redirect, which is not allowed.');
  }

  let responseUrl: URL;
  try {
    responseUrl = new URL(response.url);
  } catch{
    throw new TelegramStickerPackImportError('Telegram returned a response without a valid URL.');
  }

  if(responseUrl.origin !== TELEGRAM_BOT_API_ORIGIN) {
    throw new TelegramStickerPackImportError('Telegram response host did not match the Telegram API.');
  }
}

async function requestTelegramApi(token: string, method: TelegramMethod, parameters: Record<string, string | string[]>) {
  if(!isValidTelegramBotToken(token)) {
    throw new TelegramStickerPackImportError('Enter a valid Telegram bot token.');
  }

  const url = new URL(`/bot${token}/${method}`, TELEGRAM_BOT_API_ORIGIN);
  for(const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), FETCH_OPTIONS);
  } catch(error) {
    telegramStickerPackImportLogger.warn('Could not reach Telegram Bot API', safeErrorName(error));
    throw new TelegramStickerPackImportError('Your browser could not reach api.telegram.org.', 'network');
  }

  assertTelegramResponse(response);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch{
    throw new TelegramStickerPackImportError('Telegram returned an unreadable response.');
  }

  if(!response.ok || !isRecord(payload) || payload.ok !== true) {
    const description = isRecord(payload) && typeof payload.description === 'string' ?
      safeDescription(payload.description, token) : '';
    throw new TelegramStickerPackImportError(
      description ? `Telegram returned an error: ${description}` : `Telegram request failed (HTTP ${response.status}).`
    );
  }

  return payload.result;
}

function getCanonicalSource(name: string, type: StickerPackType) {
  const route = type === 'emoji' ? 'addemoji' : 'addstickers';
  return `https://t.me/${route}/${name}`;
}

function assertPackLink(link: TelegramStickerPackLink): StickerPackType {
  if(!isRecord(link) || !SHORT_NAME_PATTERN.test(link.name) || (link.type !== 'stickers' && link.type !== 'emoji')) {
    throw new TelegramStickerPackImportError('Enter a public Telegram sticker or custom-emoji pack link.');
  }

  return link.type;
}

function assertPackResult(value: unknown, type: StickerPackType) {
  if(!isRecord(value) || !Array.isArray(value.stickers)) {
    throw new TelegramStickerPackImportError('Telegram did not return a sticker pack.');
  }

  const expectedType = type === 'emoji' ? 'custom_emoji' : 'regular';
  if(value.sticker_type !== expectedType) {
    throw new TelegramStickerPackImportError('This Telegram link does not point to a supported pack type.');
  }

  if(typeof value.title !== 'string' || !value.title.trim()) {
    throw new TelegramStickerPackImportError('Telegram did not return a pack title.');
  }

  if(value.stickers.length === 0) {
    throw new TelegramStickerPackImportError('This Telegram pack has no stickers.');
  }

  if(value.stickers.length > MAX_TELEGRAM_PACK_FILES || value.stickers.length > getStickerPackMaxCount(type)) {
    throw new TelegramStickerPackImportError('This Telegram pack has too many stickers to import.');
  }

  if(!value.stickers.every(isRecord)) {
    throw new TelegramStickerPackImportError('Telegram returned invalid sticker information.');
  }

  return {title: value.title, stickers: value.stickers as TelegramSticker[]};
}

async function getStickerFiles(token: string, stickers: TelegramSticker[], type: StickerPackType, onProgress?: (progress: TelegramStickerPackProgress) => void) {
  const orderedStickers = type === 'emoji' ? await getCustomEmojiStickers(token, stickers) : stickers;
  const files: File[] = [];
  const emojis: string[] = [];
  let totalBytes = 0;

  for(let index = 0; index < orderedStickers.length; index++) {
    const sticker = orderedStickers[index];
    const fileId = sticker.file_id;
    if(typeof fileId !== 'string' || !fileId) {
      throw new TelegramStickerPackImportError('Telegram did not return a downloadable sticker.');
    }

    const file = await requestTelegramApi(token, 'getFile', {file_id: fileId});
    const telegramFile = assertFileResult(file);
    const extension = getStickerFileExtension(telegramFile.file_path);
    if(!extension) {
      throw new TelegramStickerPackImportError('This Telegram pack contains an unsupported file format.');
    }

    const fileLimit = STICKER_FILE_LIMITS[extension].size;
    if(telegramFile.file_size !== undefined && telegramFile.file_size > fileLimit) {
      throw new TelegramStickerPackImportError('A Telegram sticker file is too large to import.');
    }
    if(telegramFile.file_size !== undefined && telegramFile.file_size > MAX_ZIP_TOTAL_SIZE - totalBytes) {
      throw new TelegramStickerPackImportError('This Telegram pack exceeds the 110 MB download limit.');
    }

    const fileData = await downloadTelegramFile(token, telegramFile.file_path, fileLimit, MAX_ZIP_TOTAL_SIZE - totalBytes);
    totalBytes += fileData.byteLength;
    const name = `sticker-${String(index + 1).padStart(3, '0')}.${extension}`;
    try {
      files.push(new File([fileData], name, {type: STICKER_FILE_LIMITS[extension].mimeType}));
    } catch{
      throw new TelegramStickerPackImportError('Could not prepare a Telegram sticker file.');
    }

    const emoji = sticker.emoji;
    emojis.push(typeof emoji === 'string' && emoji.trim() ? safeDescription(emoji, token) : DEFAULT_STICKER_EMOJI);
    onProgress?.({current: index + 1, total: orderedStickers.length});
  }

  const validation = validateStickerPackFiles(files, type);
  if(validation.rejected.length || validation.files.length !== files.length) {
    throw new TelegramStickerPackImportError('This Telegram pack contains files Teagram cannot import.');
  }

  return {files: validation.files, emojis};
}

async function getCustomEmojiStickers(token: string, stickers: TelegramSticker[]) {
  const emojiIds = stickers.map((sticker) => sticker.custom_emoji_id);
  if(!emojiIds.every((id) => typeof id === 'string' && id)) {
    throw new TelegramStickerPackImportError('Telegram did not return custom emoji identifiers for this pack.');
  }

  const result = await requestTelegramApi(token, 'getCustomEmojiStickers', {custom_emoji_ids: emojiIds as string[]});
  if(!Array.isArray(result) || !result.every(isRecord)) {
    throw new TelegramStickerPackImportError('Telegram did not return custom emoji stickers.');
  }

  const stickersById = new Map<string, TelegramSticker>();
  for(const sticker of result as TelegramSticker[]) {
    if(typeof sticker.custom_emoji_id === 'string' && sticker.custom_emoji_id && !stickersById.has(sticker.custom_emoji_id)) {
      stickersById.set(sticker.custom_emoji_id, sticker);
    }
  }

  const ordered: TelegramSticker[] = stickers.map((sticker) => {
    const fullSticker = stickersById.get(sticker.custom_emoji_id as string);
    if(!fullSticker) {
      throw new TelegramStickerPackImportError('Telegram did not return every custom emoji sticker.');
    }

    const orderedSticker: TelegramSticker = {
      ...fullSticker,
      emoji: typeof fullSticker.emoji === 'string' ? fullSticker.emoji : sticker.emoji
    };

    return orderedSticker;
  });

  return ordered;
}

function assertFileResult(value: unknown): TelegramFile {
  if(!isRecord(value) || typeof value.file_path !== 'string') {
    throw new TelegramStickerPackImportError('Telegram did not return a downloadable file path.');
  }

  const filePath = value.file_path;
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(filePath);
  const invalidPath =
    !filePath ||
    filePath.includes('..') ||
    hasScheme ||
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    filePath.includes('?') ||
    filePath.includes('#') ||
    !/^[A-Za-z0-9_./-]+$/.test(filePath) ||
    filePath.split('/').some((part) => !part || part === '.');
  if(invalidPath) {
    throw new TelegramStickerPackImportError('Telegram returned an unsafe file path.');
  }

  let fileSize: number | undefined;
  if(value.file_size !== undefined) {
    if(typeof value.file_size !== 'number' || !Number.isSafeInteger(value.file_size) || value.file_size < 0) {
      throw new TelegramStickerPackImportError('Telegram returned an invalid file size.');
    }
    fileSize = value.file_size;
  }

  return {file_path: filePath, file_size: fileSize};
}

async function downloadTelegramFile(token: string, filePath: string, fileLimit: number, totalLimit: number) {
  const url = new URL(`/file/bot${token}/${filePath}`, TELEGRAM_BOT_API_ORIGIN);
  if(url.origin !== TELEGRAM_BOT_API_ORIGIN) {
    throw new TelegramStickerPackImportError('Telegram response host did not match the Telegram API.');
  }

  const controller = new AbortController();
  let response: Response;
  try {
    response = await fetch(url.toString(), {...FETCH_OPTIONS, signal: controller.signal});
  } catch(error) {
    telegramStickerPackImportLogger.warn('Could not download Telegram sticker file', safeErrorName(error));
    throw new TelegramStickerPackImportError('Your browser could not reach api.telegram.org.', 'network');
  }

  assertTelegramResponse(response);
  if(!response.ok) {
    throw new TelegramStickerPackImportError(`Telegram file download failed (HTTP ${response.status}).`);
  }

  const reader = response.body?.getReader();
  if(!reader) {
    throw new TelegramStickerPackImportError('Telegram returned an empty sticker file.');
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const maxSize = Math.min(fileLimit, totalLimit);
  try {
    while(true) {
      const {done, value} = await reader.read();
      if(done) break;
      if(value.byteLength > maxSize - size) {
        controller.abort();
        throw new TelegramStickerPackImportError(
          totalLimit < fileLimit ? 'This Telegram pack exceeds the 110 MB download limit.' : 'A Telegram sticker file is too large to import.'
        );
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch(error) {
    if(error instanceof TelegramStickerPackImportError) throw error;
    telegramStickerPackImportLogger.warn('Could not read Telegram sticker download', safeErrorName(error));
    throw new TelegramStickerPackImportError('Your browser could not reach api.telegram.org.', 'network');
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for(const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadTelegramStickerPack(
  link: TelegramStickerPackLink,
  token: string,
  onProgress?: (progress: TelegramStickerPackProgress) => void
): Promise<TelegramStickerPackDownload> {
  const type = assertPackLink(link);
  if(!isValidTelegramBotToken(token)) {
    throw new TelegramStickerPackImportError('Enter a valid Telegram bot token.');
  }

  const name = link.name;
  const canonicalSource = getCanonicalSource(name, type);
  const packResult = await requestTelegramApi(token, 'getStickerSet', {name});
  const {title, stickers} = assertPackResult(packResult, type);
  const downloaded = await getStickerFiles(token, stickers, type, onProgress);

  return {
    title: safeDescription(title, token),
    type,
    source: canonicalSource,
    files: downloaded.files,
    emojis: downloaded.emojis
  };
}
