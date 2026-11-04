import {FlateErrorCode, Inflate, Unzip} from 'fflate';
import type {AsyncFlateStreamHandler, FlateError, UnzipDecoder} from 'fflate';
import {getBasename, getStickerFileExtension, STICKER_FILE_LIMITS} from '@helpers/stickerPackCommon';
import type {StickerPackRejectedFile} from '@helpers/stickerPackCommon';
import {logger} from '@lib/logger';

const MAX_ZIP_ENTRIES = 201;
export const MAX_ZIP_ENTRY_SIZE = STICKER_FILE_LIMITS.webp.size;
export const MAX_ZIP_TOTAL_SIZE = 110 * 1024 * 1024;
const ZIP_ARCHIVE_CHUNK_SIZE = 64 * 1024;
const ZIP_INFLATE_INPUT_SIZE = 128;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const FLATE_ERROR_CODES = new Set<number>(Object.values(FlateErrorCode));

type StickerPackZipFailureCode =
  | 'invalid_zip'
  | 'too_many_entries'
  | 'archive_too_large'
  | 'entry_too_large'
  | 'worker_failed'
  | 'internal_error';
export type StickerPackZipError = StickerPackZipFailureCode;
type StickerPackZipBytesFile = {name: string, type: string, chunks: Uint8Array[]};
export type StickerPackZipBytesResult =
  | {ok: true, files: StickerPackZipBytesFile[], rejected: StickerPackRejectedFile[], error?: undefined}
  | {ok: false, files: [], rejected: [], error: StickerPackZipError};
export type StickerPackZipWorkerFile = {name: string, type: string, chunks: ArrayBuffer[]};
export type StickerPackZipWorkerResult =
  | {ok: true, files: StickerPackZipWorkerFile[], rejected: StickerPackRejectedFile[], error?: undefined}
  | {ok: false, files: [], rejected: [], error: StickerPackZipError};

const zipLogger = logger('StickerPackZip');

function isFlateError(error: unknown): error is FlateError {
  if(!(error instanceof Error)) return false;
  const code = (error as FlateError).code;
  return typeof code === 'number' && FLATE_ERROR_CODES.has(code);
}

function getZipEntryCount(bytes: Uint8Array) {
  const searchStart = Math.max(0, bytes.byteLength - 22 - 0xffff);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for(let offset = bytes.byteLength - 22; offset >= searchStart; offset--) {
    if(view.getUint32(offset, true) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;

    const commentLength = view.getUint16(offset + 20, true);
    if(offset + 22 + commentLength !== bytes.byteLength) continue;

    const diskNumber = view.getUint16(offset + 4, true);
    const centralDirectoryDisk = view.getUint16(offset + 6, true);
    const entriesOnDisk = view.getUint16(offset + 8, true);
    const totalEntries = view.getUint16(offset + 10, true);
    const centralDirectorySize = view.getUint32(offset + 12, true);
    const centralDirectoryOffset = view.getUint32(offset + 16, true);

    if(
      diskNumber !== 0 ||
      centralDirectoryDisk !== 0 ||
      entriesOnDisk !== totalEntries ||
      totalEntries === 0xffff ||
      centralDirectoryOffset + centralDirectorySize > offset
    ) {
      return undefined;
    }

    return totalEntries;
  }

  return undefined;
}

const zipErrorResult = (error: StickerPackZipError): StickerPackZipBytesResult => ({ok: false, files: [], rejected: [], error});

export class BoundedZipInflate implements UnzipDecoder {
  static compression = 8;
  ondata!: AsyncFlateStreamHandler;
  #inputDone = false;
  private outputSize = 0;
  private stopped = false;
  private readonly inflater: Inflate;

  constructor(private readonly onLimitExceeded: (outputChunkSize: number) => void) {
    this.inflater = new Inflate((data, final) => {
      if(this.stopped) return;
      if(this.outputSize + data.byteLength > MAX_ZIP_ENTRY_SIZE) {
        this.stopped = true;
        this.onLimitExceeded(data.byteLength);
        return;
      }

      this.outputSize += data.byteLength;
      this.ondata(null, data, final);
    });
  }

  get inputDone() {
    return this.#inputDone;
  }

  push(chunk: Uint8Array, final: boolean) {
    if(this.stopped) return;
    if(final) this.#inputDone = true;

    if(!chunk.length) {
      if(final) this.pushInflater(chunk, true);
      return;
    }

    for(let offset = 0; offset < chunk.length && !this.stopped; offset += ZIP_INFLATE_INPUT_SIZE) {
      const end = Math.min(offset + ZIP_INFLATE_INPUT_SIZE, chunk.length);
      this.pushInflater(chunk.subarray(offset, end), final && end === chunk.length);
    }
  }

  terminate() {
    this.stopped = true;
  }

  private pushInflater(chunk: Uint8Array, final: boolean) {
    try {
      this.inflater.push(chunk, final);
    } catch(err) {
      if(!isFlateError(err)) throw err;
      zipLogger.error('Invalid sticker ZIP compressed entry', err);
      this.stopped = true;
      this.ondata(err, new Uint8Array(), final);
    }
  }
}

export function readStickerPackZipBytes(bytes: Uint8Array): StickerPackZipBytesResult {
  if(bytes.byteLength > MAX_ZIP_TOTAL_SIZE) return zipErrorResult('archive_too_large');
  if(!bytes.length) return zipErrorResult('invalid_zip');

  const expectedEntryCount = getZipEntryCount(bytes);
  if(expectedEntryCount === undefined) return zipErrorResult('invalid_zip');

  const files: {order: number, file: StickerPackZipBytesFile}[] = [];
  const rejected: StickerPackRejectedFile[] = [];
  const activeEntries = new Set<{terminate?: () => void}>();
  const decoders: BoundedZipInflate[] = [];
  let entryCount = 0;
  let inflatedSize = 0;
  let error: StickerPackZipError;

  const fail = (reason: StickerPackZipError) => {
    if(error) return;
    error = reason;
    activeEntries.forEach((entry) => entry.terminate?.());
    activeEntries.clear();
  };

  class ZipInflate extends BoundedZipInflate {
    constructor() {
      super(() => fail('entry_too_large'));
      decoders.push(this);
    }
  }

  const unzip = new Unzip((entry) => {
    if(error) return;

    entryCount++;
    if(entryCount > MAX_ZIP_ENTRIES) {
      fail('too_many_entries');
      return;
    }

    const order = entryCount;
    const normalizedName = entry.name.replace(/\\/g, '/');
    const isDirectory = normalizedName.endsWith('/');
    const name = getBasename(normalizedName);
    const extension = getStickerFileExtension(name);
    const originalSize = entry.originalSize;

    if(originalSize !== undefined) {
      if(!Number.isFinite(originalSize) || originalSize < 0) {
        fail('invalid_zip');
        return;
      }
      if(originalSize > MAX_ZIP_ENTRY_SIZE) {
        fail('entry_too_large');
        return;
      }
    }

    if(!extension && !isDirectory) rejected.push({name, reason: 'unsupported_format'});

    const chunks: Uint8Array[] = [];
    let fileSize = 0;
    let finished = false;
    let tooLarge = false;
    activeEntries.add(entry);

    const release = () => activeEntries.delete(entry);
    entry.ondata = (err, data, final) => {
      if(finished || error) return;
      if(err) {
        zipLogger.error('Could not inflate a sticker ZIP entry', err);
        fail('invalid_zip');
        finished = true;
        release();
        return;
      }

      fileSize += data.byteLength;
      inflatedSize += data.byteLength;
      if(inflatedSize > MAX_ZIP_TOTAL_SIZE) {
        fail('archive_too_large');
        finished = true;
        release();
        return;
      }
      if(fileSize > MAX_ZIP_ENTRY_SIZE) {
        fail('entry_too_large');
        finished = true;
        release();
        return;
      }

      if(!tooLarge && extension && fileSize > STICKER_FILE_LIMITS[extension].size) {
        tooLarge = true;
        rejected.push({name, reason: 'too_large'});
        chunks.length = 0;
      } else if(extension && !tooLarge) {
        chunks.push(data);
      }

      if(final) {
        if(extension && !tooLarge && !isDirectory) {
          files.push({
            order,
            file: {name, type: STICKER_FILE_LIMITS[extension].mimeType, chunks}
          });
        }
        finished = true;
        release();
      }
    };

    entry.start();
  });

  unzip.register(ZipInflate);

  try {
    for(let offset = 0; offset < bytes.length && !error; offset += ZIP_ARCHIVE_CHUNK_SIZE) {
      const end = Math.min(offset + ZIP_ARCHIVE_CHUNK_SIZE, bytes.length);
      unzip.push(bytes.subarray(offset, end), end === bytes.length);
    }
  } catch(err) {
    if(!isFlateError(err)) {
      zipLogger.error('Unexpected sticker ZIP parser failure', err);
      throw err;
    }
    zipLogger.error('Invalid sticker ZIP archive', err);
    fail('invalid_zip');
  }

  if(!error && decoders.some((decoder) => !decoder.inputDone)) fail('invalid_zip');
  if(!error && entryCount !== expectedEntryCount) fail('invalid_zip');
  if(error) return zipErrorResult(error);
  return {ok: true, files: files.sort((a, b) => a.order - b.order).map(({file}) => file), rejected};
}
