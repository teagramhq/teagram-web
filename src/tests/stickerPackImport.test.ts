import {deflateSync, zipSync} from 'fflate';
import {describe, expect, it, vi} from 'vitest';
import {readStickerPackZip, validateStickerPackFiles} from '@helpers/stickerPackImport';
import {BoundedZipInflate, readStickerPackZipBytes} from '@helpers/stickerPackImportZip';
import {getStickerFileMimeType, isStickerPackImportEnabled} from '@helpers/stickerPackCommon';
import {createStickerSetShareLink, parseStickerSetShareLink, processInitialStickerSetShareLink, setStickerSetLinkPrefix} from '@helpers/stickerSetLink';

const makeFile = (name: string, size: number) => new File([new Uint8Array(size)], name);

describe('sticker pack import files', () => {
  it('accepts supported files within their format limits and reports the rest', () => {
    const result = validateStickerPackFiles([
      makeFile('cat.WEBP', 512 * 1024),
      makeFile('loop.tgs', 64 * 1024 + 1),
      makeFile('clip.webm', 256 * 1024),
      makeFile('photo.png', 8)
    ], 'stickers');

    expect(result.files.map((file) => file.name)).toEqual(['cat.WEBP', 'clip.webm']);
    expect(result.rejected).toEqual([
      {name: 'loop.tgs', reason: 'too_large'},
      {name: 'photo.png', reason: 'unsupported_format'}
    ]);
  });

  it('keeps no more than the set type allows and reports excess files', () => {
    const stickers = validateStickerPackFiles(
      Array.from({length: 121}, (_, index) => makeFile(`sticker-${index}.webp`, 1)),
      'stickers'
    );
    const emoji = validateStickerPackFiles(
      Array.from({length: 201}, (_, index) => makeFile(`emoji-${index}.webp`, 1)),
      'emoji'
    );

    expect(stickers.files).toHaveLength(120);
    expect(stickers.rejected).toHaveLength(1);
    expect(stickers.rejected[0]).toEqual({name: 'sticker-120.webp', reason: 'too_many'});
    expect(emoji.files).toHaveLength(200);
    expect(emoji.rejected).toHaveLength(1);
    expect(emoji.rejected[0]).toEqual({name: 'emoji-200.webp', reason: 'too_many'});
  });

  it('uses only an archive entry basename when creating an upload file', async() => {
    const archive = zipSync({'../animals/cat.webp': Uint8Array.from([1, 2, 3])});
    const result = readStickerPackZipBytes(archive);

    expect(result.error).toBeUndefined();
    expect(result.files.map((file) => file.name)).toEqual(['cat.webp']);
    expect(Array.from(result.files[0].chunks.flatMap((chunk) => Array.from(chunk)))).toEqual([1, 2, 3]);
    expect(result.rejected).toEqual([]);
  });

  it('skips macOS AppleDouble metadata entries before format validation', () => {
    const archive = zipSync({
      '__MACOSX/._cat.webp': Uint8Array.from([9, 9]),
      'nested/._dog.webp': Uint8Array.from([8, 8]),
      'cat.webp': Uint8Array.from([1, 2, 3])
    });
    const result = readStickerPackZipBytes(archive);

    expect(result.error).toBeUndefined();
    expect(result.files.map((file) => file.name)).toEqual(['cat.webp']);
    expect(result.rejected).toEqual([]);
  });

  it('shows the settings import row only when server config explicitly enables it', () => {
    expect(isStickerPackImportEnabled('on')).toBe(true);
    expect(isStickerPackImportEnabled('off')).toBe(false);
    expect(isStickerPackImportEnabled(undefined)).toBe(false);
  });

  it('uses one explicit MIME map and rejects unknown extensions', () => {
    expect(getStickerFileMimeType('cat.WEBP')).toBe('image/webp');
    expect(getStickerFileMimeType('loop.tgs')).toBe('application/x-tgsticker');
    expect(getStickerFileMimeType('clip.webm')).toBe('video/webm');
    expect(() => getStickerFileMimeType('cat.png')).toThrow('Unsupported sticker file format');
  });

  it('reports and logs a ZIP worker load failure distinctly from invalid archive data', async() => {
    const workerInstances: Array<{terminate: ReturnType<typeof vi.fn>}> = [];
    class WorkerMock extends EventTarget {
      constructor() {
        super();
        workerInstances.push(this);
      }

      terminate = vi.fn();
      postMessage() {
        queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', {message: 'worker blocked by CSP'})));
      }
    }
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('Worker', WorkerMock);

    try {
      const result = await readStickerPackZip(new File([Uint8Array.from([1])], 'pack.zip'));

      expect(result).toEqual({ok: false, files: [], rejected: [], error: 'worker_failed'});
      expect(workerInstances[0].terminate).toHaveBeenCalledOnce();
      expect(logError).toHaveBeenCalled();

      vi.stubGlobal('Worker', class {
        constructor() {
          throw new Error('worker-src blocked by CSP');
        }
      });
      await expect(readStickerPackZip(new File([Uint8Array.from([1])], 'pack.zip')))
        .resolves.toEqual({ok: false, files: [], rejected: [], error: 'worker_failed'});
    } finally {
      vi.unstubAllGlobals();
      logError.mockRestore();
    }
  });

  it('stops reading a zip after its 201st entry', async() => {
    const entries = Object.fromEntries(
      Array.from({length: 202}, (_, index) => [`${index}.webp`, Uint8Array.from([1])])
    );
    const archive = zipSync(entries, {level: 0});
    const result = readStickerPackZipBytes(archive);

    expect(result.error).toBe('too_many_entries');
    expect(result.files).toHaveLength(0);
  });

  it('blocks an archive with an entry larger than the server limit', async() => {
    const archive = zipSync({'too-large.txt': new Uint8Array(512 * 1024 + 1)}, {level: 0});
    const result = readStickerPackZipBytes(archive);

    expect(result.error).toBe('entry_too_large');
    expect(result.files).toHaveLength(0);
  });

  it('bounds each inflate output chunk and stops a compressed entry at the server limit', () => {
    const compressed = deflateSync(new Uint8Array(4 * 1024 * 1024).fill(65), {level: 9});
    let receivedBytes = 0;
    let largestOutputChunk = 0;
    const onLimitExceeded = vi.fn();
    const inflater = new BoundedZipInflate(onLimitExceeded);
    inflater.ondata = (error, data) => {
      expect(error).toBeNull();
      if(!data) return;
      receivedBytes += data.byteLength;
      largestOutputChunk = Math.max(largestOutputChunk, data.byteLength);
    };

    inflater.push(compressed, true);

    expect(onLimitExceeded).toHaveBeenCalledTimes(1);
    expect(receivedBytes).toBeLessThanOrEqual(512 * 1024);
    expect(largestOutputChunk).toBeGreaterThan(0);
  });

  it('keeps the inflater completion flag read-only', () => {
    const inflater = new BoundedZipInflate(vi.fn());
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inflater), 'inputDone');

    expect(descriptor?.get).toBeTypeOf('function');
    expect(descriptor?.set).toBeUndefined();
  });

  it('passes callback failures through instead of reporting them as malformed ZIP data', () => {
    const callbackError = new Error('entry callback failed');
    const ondata = vi.fn((error: Error | null) => {
      if(!error) throw callbackError;
    });
    const inflater = new BoundedZipInflate(vi.fn());
    inflater.ondata = ondata;

    expect(() => inflater.push(deflateSync(Uint8Array.from([1, 2, 3])), true)).toThrow(callbackError);
    expect(ondata).toHaveBeenCalledTimes(1);
  });

  it('rejects a compressed oversized entry even when its ZIP size field is falsified', () => {
    const archive = zipSync({'bomb.webp': new Uint8Array(4 * 1024 * 1024).fill(65)}, {level: 9});
    const forgedArchive = archive.slice();
    // ZIP local header: the uncompressed size is at byte 22. The compressed data and its length stay intact.
    new DataView(forgedArchive.buffer, forgedArchive.byteOffset, forgedArchive.byteLength).setUint32(22, 0, true);

    const result = readStickerPackZipBytes(forgedArchive);

    expect(result.error).toBe('entry_too_large');
    expect(result.files).toHaveLength(0);
  });
});

describe('sticker set share links', () => {
  it('builds and parses a link using the server prefix and set type', () => {
    const stickers = createStickerSetShareLink('https://teagram.test/links/', 'cats_a', false);
    const emoji = createStickerSetShareLink('https://teagram.test/links/', 'faces_2', true);

    expect(stickers).toBe('https://teagram.test/links/addstickers/cats_a');
    expect(emoji).toBe('https://teagram.test/links/addemoji/faces_2');
    expect(parseStickerSetShareLink(stickers, 'https://teagram.test/links/')).toEqual({shortName: 'cats_a', isEmoji: false});
    expect(parseStickerSetShareLink(emoji, 'https://teagram.test/links/')).toEqual({shortName: 'faces_2', isEmoji: true});
  });

  it('rejects links outside the exact server prefix and names outside the allowed pattern', () => {
    expect(parseStickerSetShareLink('https://other.test/addstickers/cats_a', 'https://teagram.test/')).toBeUndefined();
    expect(parseStickerSetShareLink('https://teagram.test/addstickers/cats%2Fa', 'https://teagram.test/')).toBeUndefined();
    expect(parseStickerSetShareLink('https://teagram.test/addstickers/cats_a/extra', 'https://teagram.test/')).toBeUndefined();
    expect(parseStickerSetShareLink('https://teagram.test/addstickers/cats_a?start=1', 'https://teagram.test/')).toBeUndefined();
  });

  it('opens a direct navigation only after the server config supplies its link prefix', async() => {
    let resolveConfig: (config: {me_url_prefix: string}) => void;
    const config = new Promise<{me_url_prefix: string}>((resolve) => resolveConfig = resolve);
    const openSet = vi.fn();
    const opening = processInitialStickerSetShareLink('https://teagram.test/addemoji/faces_2', config, openSet);

    expect(openSet).not.toHaveBeenCalled();
    resolveConfig({me_url_prefix: 'https://teagram.test/'});
    await opening;

    expect(openSet).toHaveBeenCalledExactlyOnceWith({shortName: 'faces_2', isEmoji: true});
  });

  it('surfaces a failed config lookup instead of silently ignoring a share link', async() => {
    const configError = new Error('config unavailable');

    await expect(processInitialStickerSetShareLink(
      'https://teagram.test/addstickers/cats_a',
      Promise.reject(configError),
      vi.fn()
    )).rejects.toBe(configError);
  });

  it('does not load sticker link config for unrelated initial routes', async() => {
    const configError = new Error('config unavailable');
    const config = Promise.reject<{me_url_prefix: string}>(configError);
    void config.catch((_error): undefined => undefined);

    await expect(processInitialStickerSetShareLink('https://teagram.test/invite?token=abc', config, vi.fn()))
      .resolves.toBeUndefined();
  });

  it('logs and rejects an invalid server link prefix', () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(setStickerSetLinkPrefix('javascript:alert(1)')).toBe(false);
      expect(logError).toHaveBeenCalled();
    } finally {
      logError.mockRestore();
    }
  });
});

describe('sticker pack zip streaming', () => {
  it('returns files in archive order after bounded streaming inflation', () => {
    const entries = Object.fromEntries(
      Array.from({length: 6}, (_, index) => [`${index}.webp`, new Uint8Array(200 * 1024).fill(index)])
    );
    const archive = zipSync(entries, {level: 6});
    const result = readStickerPackZipBytes(archive);

    expect(result.error).toBeUndefined();
    expect(result.files.map((file) => file.name)).toEqual(['0.webp', '1.webp', '2.webp', '3.webp', '4.webp', '5.webp']);
  });

  it('reports a truncated archive instead of returning its partial entries', () => {
    const archive = zipSync({'a.webp': new Uint8Array(100 * 1024).fill(7), 'b.webp': new Uint8Array(100 * 1024).fill(9)}, {level: 6});
    const result = readStickerPackZipBytes(archive.slice(0, archive.length - 1000));

    expect(result.error).toBe('invalid_zip');
    expect(result.files).toHaveLength(0);
  });

  it('rejects an archive truncated inside a local file header', () => {
    const archive = zipSync({'a.webp': Uint8Array.from([1, 2, 3])});
    const result = readStickerPackZipBytes(archive.slice(0, 12));

    expect(result.error).toBe('invalid_zip');
    expect(result.files).toHaveLength(0);
  });
});
