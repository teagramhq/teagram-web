import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@helpers/stickerPackImportZip', async(importOriginal) => {
  const actual = await importOriginal<typeof import('@helpers/stickerPackImportZip')>();
  return {...actual, MAX_ZIP_TOTAL_SIZE: 5};
});

import {downloadTelegramStickerPack, parseTelegramStickerPackLink} from '@helpers/telegramStickerPackImport';

const token = `123456789:${'A'.repeat(35)}`;

function jsonResponse(url: URL, body: unknown) {
  const response = new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}});
  Object.defineProperty(response, 'url', {value: url.toString()});
  return response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Telegram pack total download limit', () => {
  it('rejects cumulative file bytes beyond the configured total before downloading the next file', async() => {
    const actualZip = await vi.importActual<typeof import('@helpers/stickerPackImportZip')>('@helpers/stickerPackImportZip');
    const requests: URL[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      if(url.pathname.endsWith('/getStickerSet')) {
        return Promise.resolve(jsonResponse(url, {
          ok: true,
          result: {
            name: 'Cats_2',
            title: 'Cats',
            sticker_type: 'regular',
            stickers: [{file_id: 'file-1'}, {file_id: 'file-2'}]
          }
        }));
      }
      if(url.pathname.endsWith('/getFile')) {
        const fileId = url.searchParams.get('file_id');
        return Promise.resolve(jsonResponse(url, {
          ok: true,
          result: {file_id: fileId, file_size: 3, file_path: `stickers/${fileId}.webp`}
        }));
      }
      const response = new Response(Uint8Array.from([1, 2, 3]));
      Object.defineProperty(response, 'url', {value: url.toString()});
      return Promise.resolve(response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;

    expect(actualZip.MAX_ZIP_TOTAL_SIZE).toBe(110 * 1024 * 1024);
    await expect(downloadTelegramStickerPack(link, token)).rejects.toThrow(/110 MB download limit/i);
    expect(requests.map((url) => url.pathname.split('/').pop())).toEqual([
      'getStickerSet',
      'getFile',
      'file-1.webp',
      'getFile'
    ]);
  });
});
