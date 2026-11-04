import {readStickerPackZipBytes} from '@helpers/stickerPackImportZip';

self.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
  try {
    const result = readStickerPackZipBytes(new Uint8Array(event.data));
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
    self.postMessage({files: [], rejected: [], error: 'invalid_zip'});
  }
});
