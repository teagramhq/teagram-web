import {AsyncFlateStreamHandler, AsyncInflate, Unzip, UnzipDecoder} from 'fflate';

export type StickerPackType = 'stickers' | 'emoji';
export type StickerPackRejectionReason = 'too_large' | 'too_many' | 'unsupported_format';
export type StickerPackRejectedFile = {name: string, reason: StickerPackRejectionReason};
export type StickerPackFilesResult = {files: File[], rejected: StickerPackRejectedFile[]};
export type StickerPackZipResult = StickerPackFilesResult & {error?: 'invalid_zip' | 'too_many_entries' | 'archive_too_large' | 'entry_too_large'};

const MAX_ZIP_ENTRIES = 201;
const MAX_ZIP_ENTRY_SIZE = 512 * 1024;
const MAX_ZIP_TOTAL_SIZE = 110 * 1024 * 1024;
const ZIP_CHUNK_SIZE = 64 * 1024;
// Hands the event loop a turn every 1 MiB of archive so progress and cancel can paint while a big zip is read.
const ZIP_CHUNKS_PER_TURN = 16;

const STICKER_FILE_LIMITS = {
  webp: {size: 512 * 1024, mimeType: 'image/webp'},
  tgs: {size: 64 * 1024, mimeType: 'application/x-tgsticker'},
  webm: {size: 256 * 1024, mimeType: 'video/webm'}
} as const;

type StickerFileExtension = keyof typeof STICKER_FILE_LIMITS;

function getFileExtension(name: string): StickerFileExtension | undefined {
  const match = /\.([^.]+)$/.exec(name);
  const extension = match?.[1].toLowerCase();
  return extension && extension in STICKER_FILE_LIMITS ? extension as StickerFileExtension : undefined;
}

function getBasename(name: string) {
  return name.replace(/\\/g, '/').split('/').pop() || '';
}

function getMaxCount(type: StickerPackType) {
  return type === 'emoji' ? 200 : 120;
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setTimeout(resolve));
}

export function validateStickerPackFiles(files: File[], type: StickerPackType): StickerPackFilesResult {
  const accepted: File[] = [];
  const rejected: StickerPackRejectedFile[] = [];
  const maxCount = getMaxCount(type);

  for(const file of files) {
    const name = getBasename(file.name);
    const extension = getFileExtension(name);
    if(!extension) {
      rejected.push({name, reason: 'unsupported_format'});
      continue;
    }

    if(file.size > STICKER_FILE_LIMITS[extension].size) {
      rejected.push({name, reason: 'too_large'});
      continue;
    }

    if(accepted.length >= maxCount) {
      rejected.push({name, reason: 'too_many'});
      continue;
    }

    accepted.push(file);
  }

  return {files: accepted, rejected};
}

export async function readStickerPackZip(archive: File): Promise<StickerPackZipResult> {
  if(archive.size > MAX_ZIP_TOTAL_SIZE) {
    return {files: [], rejected: [], error: 'archive_too_large'};
  }

  const bytes = new Uint8Array(await archive.arrayBuffer());
  const files: {order: number, file: File}[] = [];
  const rejected: StickerPackRejectedFile[] = [];
  const activeEntries = new Set<{terminate: () => void}>();
  // Every decoder Unzip started; one that never got its final chunk belongs to a truncated archive.
  const decoders: {inputDone: boolean}[] = [];
  let entryCount = 0;
  let inflatedSize = 0;
  let error: StickerPackZipResult['error'];
  let onIdle: (() => void) | undefined;

  const release = (entry: {terminate: () => void}) => {
    activeEntries.delete(entry);
    if(!activeEntries.size) onIdle?.();
  };

  const fail = (reason: NonNullable<StickerPackZipResult['error']>) => {
    if(error) return;
    error = reason;
    activeEntries.forEach((entry) => entry.terminate());
    activeEntries.clear();
    onIdle?.();
  };

  // Inflation runs in fflate's worker-backed AsyncInflate. UnzipInflate would inflate on this thread,
  // so a near-limit archive would hold the page for the whole ~110 MB, progress and cancel included.
  class ZipInflate implements UnzipDecoder {
    static compression = 8;
    ondata!: AsyncFlateStreamHandler;
    inputDone = false;
    private readonly inflate = new AsyncInflate((err, data, final) => this.ondata(err, data, final));

    constructor() {
      decoders.push(this);
    }

    terminate() {
      this.inflate.terminate();
    }

    push(chunk: Uint8Array, final: boolean) {
      if(final) this.inputDone = true;
      // The chunk is a view into `bytes`; copy it so the worker's transfer cannot detach the archive.
      this.inflate.push(chunk.slice(), final);
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

    if(!extension && !isDirectory) {
      rejected.push({name, reason: 'unsupported_format'});
    }

    const maxFileSize = extension ? STICKER_FILE_LIMITS[extension].size : undefined;
    const chunks: Uint8Array[] = [];
    let fileSize = 0;
    let finished = false;
    let tooLarge = false;
    activeEntries.add(entry);

    entry.ondata = (err, data, final) => {
      if(finished || error) return;
      if(err) {
        fail('invalid_zip');
        finished = true;
        release(entry);
        return;
      }

      fileSize += data.byteLength;
      inflatedSize += data.byteLength;
      if(inflatedSize > MAX_ZIP_TOTAL_SIZE) {
        fail('archive_too_large');
        finished = true;
        release(entry);
        return;
      }
      if(fileSize > MAX_ZIP_ENTRY_SIZE) {
        fail('entry_too_large');
        finished = true;
        release(entry);
        return;
      }

      if(!tooLarge && maxFileSize !== undefined && fileSize > maxFileSize) {
        tooLarge = true;
        rejected.push({name, reason: 'too_large'});
        chunks.length = 0;
      } else if(extension && !tooLarge) {
        chunks.push(data);
      }

      if(final) {
        if(extension && !tooLarge && !isDirectory) {
          const content = new Uint8Array(fileSize);
          let offset = 0;
          for(const chunk of chunks) {
            content.set(chunk, offset);
            offset += chunk.byteLength;
          }
          files.push({order, file: new File([content.buffer], name, {type: STICKER_FILE_LIMITS[extension].mimeType})});
        }
        finished = true;
        release(entry);
      }
    };

    entry.start();
  });

  unzip.register(ZipInflate);

  try {
    if(!bytes.length) return {files: [], rejected: [], error: 'invalid_zip'};

    let chunkCount = 0;
    for(let offset = 0; offset < bytes.length && !error; offset += ZIP_CHUNK_SIZE) {
      const end = Math.min(offset + ZIP_CHUNK_SIZE, bytes.length);
      unzip.push(bytes.subarray(offset, end), end === bytes.length);
      if(++chunkCount % ZIP_CHUNKS_PER_TURN === 0) await yieldToEventLoop();
    }
  } catch(err) {
    fail('invalid_zip');
  }

  if(!error && decoders.some((decoder) => !decoder.inputDone)) fail('invalid_zip');

  // Inflation finishes after the loop above, so wait for every entry to settle or the stream to fail.
  await new Promise<void>((resolve) => {
    onIdle = resolve;
    if(error || !activeEntries.size) resolve();
  });

  if(error) return {files: [], rejected: [], error};
  return {files: files.sort((a, b) => a.order - b.order).map(({file}) => file), rejected};
}
