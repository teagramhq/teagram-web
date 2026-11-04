import {MAX_ZIP_TOTAL_SIZE, StickerPackZipBytesResult} from '@helpers/stickerPackImportZip';

export type StickerPackType = 'stickers' | 'emoji';
export type StickerPackRejectionReason = 'too_large' | 'too_many' | 'unsupported_format';
export type StickerPackRejectedFile = {name: string, reason: StickerPackRejectionReason};
export type StickerPackFilesResult = {files: File[], rejected: StickerPackRejectedFile[]};
export type StickerPackZipResult = Omit<StickerPackZipBytesResult, 'files'> & {files: File[]};

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

type StickerPackZipWorkerFile = {name: string, type: string, chunks: ArrayBuffer[]};
type StickerPackZipWorkerResult = Omit<StickerPackZipBytesResult, 'files'> & {files: StickerPackZipWorkerFile[]};

export async function readStickerPackZip(archive: File): Promise<StickerPackZipResult> {
  if(archive.size > MAX_ZIP_TOTAL_SIZE) {
    return {files: [], rejected: [], error: 'archive_too_large'};
  }

  const bytes = await archive.arrayBuffer();
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./stickerPackImportZip.worker.ts', import.meta.url), {type: 'module'});
    let settled = false;
    const settle = (result: StickerPackZipWorkerResult) => {
      if(settled) return;
      settled = true;
      worker.terminate();
      try {
        resolve({
          ...result,
          files: result.files.map(({name, type, chunks}) => new File(chunks, name, {type}))
        });
      } catch(err) {
        resolve({files: [], rejected: [], error: 'invalid_zip'});
      }
    };

    worker.addEventListener('message', (event: MessageEvent<StickerPackZipWorkerResult>) => settle(event.data), {once: true});
    worker.addEventListener('error', () => settle({files: [], rejected: [], error: 'invalid_zip'}), {once: true});
    worker.addEventListener('messageerror', () => settle({files: [], rejected: [], error: 'invalid_zip'}), {once: true});
    worker.postMessage(bytes, [bytes]);
  });
}
