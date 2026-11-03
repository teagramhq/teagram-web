import {Unzip, UnzipInflate} from 'fflate';

export type StickerPackType = 'stickers' | 'emoji';
export type StickerPackRejectionReason = 'too_large' | 'too_many' | 'unsupported_format';
export type StickerPackRejectedFile = {name: string, reason: StickerPackRejectionReason};
export type StickerPackFilesResult = {files: File[], rejected: StickerPackRejectedFile[]};
export type StickerPackZipResult = StickerPackFilesResult & {error?: 'invalid_zip' | 'too_many_entries' | 'archive_too_large' | 'entry_too_large'};

const MAX_ZIP_ENTRIES = 201;
const MAX_ZIP_ENTRY_SIZE = 512 * 1024;
const MAX_ZIP_TOTAL_SIZE = 110 * 1024 * 1024;
const ZIP_CHUNK_SIZE = 64 * 1024;

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
  const files: File[] = [];
  const rejected: StickerPackRejectedFile[] = [];
  const activeEntries = new Set<{terminate: () => void}>();
  let entryCount = 0;
  let inflatedSize = 0;
  let error: StickerPackZipResult['error'];

  const fail = (reason: NonNullable<StickerPackZipResult['error']>) => {
    if(error) return;
    error = reason;
    activeEntries.forEach((entry) => entry.terminate());
    activeEntries.clear();
  };

  const unzip = new Unzip((entry) => {
    if(error) return;

    entryCount++;
    if(entryCount > MAX_ZIP_ENTRIES) {
      fail('too_many_entries');
      return;
    }

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
        activeEntries.delete(entry);
        return;
      }

      fileSize += data.byteLength;
      inflatedSize += data.byteLength;
      if(inflatedSize > MAX_ZIP_TOTAL_SIZE) {
        fail('archive_too_large');
        finished = true;
        activeEntries.delete(entry);
        return;
      }
      if(fileSize > MAX_ZIP_ENTRY_SIZE) {
        fail('entry_too_large');
        finished = true;
        activeEntries.delete(entry);
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
          files.push(new File([content.buffer], name, {type: STICKER_FILE_LIMITS[extension].mimeType}));
        }
        finished = true;
        activeEntries.delete(entry);
      }
    };

    entry.start();
  });

  unzip.register(UnzipInflate);

  try {
    if(!bytes.length) return {files: [], rejected: [], error: 'invalid_zip'};

    for(let offset = 0; offset < bytes.length && !error; offset += ZIP_CHUNK_SIZE) {
      const end = Math.min(offset + ZIP_CHUNK_SIZE, bytes.length);
      unzip.push(bytes.subarray(offset, end), end === bytes.length);
    }
  } catch(err) {
    fail('invalid_zip');
  }

  if(activeEntries.size && !error) fail('invalid_zip');
  if(error) return {files: [], rejected: [], error};
  return {files, rejected};
}
