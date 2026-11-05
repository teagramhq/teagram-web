import {readStickerPackZipBytes} from '@helpers/stickerPackImportZip';
import {logger} from '@lib/logger';

const zipWorkerLogger = logger('StickerPackImportZipWorker');

self.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
  try {
    const result = readStickerPackZipBytes(new Uint8Array(event.data));
    if(!result.ok) {
      self.postMessage(result);
      return;
    }

    const files = result.files.map(({name, type, chunks}) => ({
      name,
      type,
      chunks: chunks.map((chunk) => chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ?
        chunk.buffer as ArrayBuffer : chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
      )
    }));
    const transferables = files.flatMap(({chunks}) => chunks);
    self.postMessage({...result, files}, transferables);
  } catch(err) {
    zipWorkerLogger.error('Unexpected sticker pack ZIP worker failure', err);
    self.postMessage({ok: false, files: [], rejected: [], error: 'internal_error'});
  }
});
