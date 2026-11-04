import {MAX_ZIP_TOTAL_SIZE} from '@helpers/stickerPackImportZip';
import type {StickerPackZipError, StickerPackZipWorkerResult} from '@helpers/stickerPackImportZip';
import {getBasename, getStickerFileExtension, getStickerPackMaxCount, STICKER_FILE_LIMITS} from '@helpers/stickerPackCommon';
import type {StickerPackRejectedFile, StickerPackType, ValidatedStickerPackFiles} from '@helpers/stickerPackCommon';
import {logger} from '@lib/logger';

export type {StickerPackRejectedFile, StickerPackRejectionReason, StickerPackType, ValidatedStickerPackFiles} from '@helpers/stickerPackCommon';
export type StickerPackFilesResult = {files: ValidatedStickerPackFiles, rejected: StickerPackRejectedFile[]};
export type StickerPackZipResult =
  | {ok: true, files: File[], rejected: StickerPackRejectedFile[], error?: undefined}
  | {ok: false, files: [], rejected: [], error: StickerPackZipError};

const importLogger = logger('StickerPackImport');

export function validateStickerPackFiles(files: File[], type: StickerPackType): StickerPackFilesResult {
  const accepted: File[] = [];
  const rejected: StickerPackRejectedFile[] = [];
  const maxCount = getStickerPackMaxCount(type);

  for(const file of files) {
    const name = getBasename(file.name);
    const extension = getStickerFileExtension(name);
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

  return {files: accepted as ValidatedStickerPackFiles, rejected};
}

const zipErrorResult = (error: StickerPackZipError): StickerPackZipResult => ({ok: false, files: [], rejected: [], error});

export async function readStickerPackZip(archive: File): Promise<StickerPackZipResult> {
  if(archive.size > MAX_ZIP_TOTAL_SIZE) return zipErrorResult('archive_too_large');

  const bytes = await archive.arrayBuffer();
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./stickerPackImportZip.worker.ts', import.meta.url), {type: 'module'});
    } catch(err) {
      importLogger.error('Could not start the sticker pack ZIP worker', err);
      resolve(zipErrorResult('worker_failed'));
      return;
    }

    let settled = false;
    const settleError = (error: StickerPackZipError) => {
      if(settled) return;
      settled = true;
      worker.terminate();
      resolve(zipErrorResult(error));
    };
    const settle = (result: StickerPackZipWorkerResult) => {
      if(settled) return;
      settled = true;
      worker.terminate();
      if(result.ok === false) {
        resolve(zipErrorResult(result.error));
        return;
      }

      try {
        resolve({
          ...result,
          files: result.files.map(({name, type, chunks}) => new File(chunks, name, {type}))
        });
      } catch(err) {
        importLogger.error('Could not restore sticker files from ZIP worker output', err);
        resolve(zipErrorResult('internal_error'));
      }
    };

    worker.addEventListener('message', (event: MessageEvent<StickerPackZipWorkerResult>) => settle(event.data), {once: true});
    worker.addEventListener('error', (event) => {
      const errorEvent = event as ErrorEvent;
      importLogger.error('Sticker pack ZIP worker failed to load or run', errorEvent.message, errorEvent.error);
      settleError('worker_failed');
    }, {once: true});
    worker.addEventListener('messageerror', (event) => {
      importLogger.error('Could not read the sticker pack ZIP worker response', event);
      settleError('internal_error');
    }, {once: true});

    try {
      worker.postMessage(bytes, [bytes]);
    } catch(err) {
      importLogger.error('Could not send the sticker pack ZIP to its worker', err);
      settleError('worker_failed');
    }
  });
}
