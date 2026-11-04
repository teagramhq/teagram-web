import {Inflate, Unzip} from 'fflate';
import type {AsyncFlateStreamHandler, FlateError, UnzipDecoder} from 'fflate';
import type {StickerPackRejectedFile} from '@helpers/stickerPackImport';

const MAX_ZIP_ENTRIES = 201;
export const MAX_ZIP_ENTRY_SIZE = 512 * 1024;
export const MAX_ZIP_TOTAL_SIZE = 110 * 1024 * 1024;
const ZIP_ARCHIVE_CHUNK_SIZE = 64 * 1024;
const ZIP_INFLATE_INPUT_SIZE = 128;

const STICKER_FILE_LIMITS = {
  webp: {size: 512 * 1024, mimeType: 'image/webp'},
  tgs: {size: 64 * 1024, mimeType: 'application/x-tgsticker'},
  webm: {size: 256 * 1024, mimeType: 'video/webm'}
} as const;

type StickerFileExtension = keyof typeof STICKER_FILE_LIMITS;
type StickerPackZipError = 'invalid_zip' | 'too_many_entries' | 'archive_too_large' | 'entry_too_large';
type StickerPackZipBytesFile = {name: string, type: string, chunks: Uint8Array[]};
export type StickerPackZipBytesResult = {
  files: StickerPackZipBytesFile[],
  rejected: StickerPackRejectedFile[],
  error?: StickerPackZipError
};

function getFileExtension(name: string): StickerFileExtension | undefined {
  const match = /\.([^.]+)$/.exec(name);
  const extension = match?.[1].toLowerCase();
  return extension && extension in STICKER_FILE_LIMITS ? extension as StickerFileExtension : undefined;
}

function getBasename(name: string) {
  return name.replace(/\\/g, '/').split('/').pop() || '';
}

export class BoundedZipInflate implements UnzipDecoder {
  static compression = 8;
  ondata!: AsyncFlateStreamHandler;
  inputDone = false;
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

  push(chunk: Uint8Array, final: boolean) {
    if(this.stopped) return;
    if(final) this.inputDone = true;

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
      this.stopped = true;
      const flateError = err instanceof Error && 'code' in err ? err as FlateError : Object.assign(new Error('Invalid ZIP data'), {code: 13});
      this.ondata(flateError, new Uint8Array(), final);
    }
  }
}

export function readStickerPackZipBytes(bytes: Uint8Array): StickerPackZipBytesResult {
  if(bytes.byteLength > MAX_ZIP_TOTAL_SIZE) return {files: [], rejected: [], error: 'archive_too_large'};

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
    const extension = getFileExtension(name);
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
    if(!bytes.length) return {files: [], rejected: [], error: 'invalid_zip'};
    for(let offset = 0; offset < bytes.length && !error; offset += ZIP_ARCHIVE_CHUNK_SIZE) {
      const end = Math.min(offset + ZIP_ARCHIVE_CHUNK_SIZE, bytes.length);
      unzip.push(bytes.subarray(offset, end), end === bytes.length);
    }
  } catch(err) {
    fail('invalid_zip');
  }

  if(!error && decoders.some((decoder) => !decoder.inputDone)) fail('invalid_zip');
  if(error) return {files: [], rejected: [], error};
  return {files: files.sort((a, b) => a.order - b.order).map(({file}) => file), rejected};
}
