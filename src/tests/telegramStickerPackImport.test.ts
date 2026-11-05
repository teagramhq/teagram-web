import {afterEach, describe, expect, it, vi} from 'vitest';
import {isTelegramBotApiUrl} from '@config/telegramBotApi';
import {downloadTelegramStickerPack, getTelegramStickerPackUploadOptions, isValidTelegramBotToken, parseTelegramStickerPackLink} from '@helpers/telegramStickerPackImport';
import {AppStickersManager} from '@appManagers/appStickersManager';

const makeJsonResponse = (url: string, body: unknown, status = 200) => {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'}
  });
  Object.defineProperty(response, 'url', {value: url});
  return response;
};

const makeFileResponse = (url: string, body: number[]) => {
  const response = new Response(Uint8Array.from(body));
  Object.defineProperty(response, 'url', {value: url});
  return response;
};

const mockTelegramFetch = (handler: (url: URL) => Response | Promise<Response>) => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => handler(new URL(String(input))));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const token = `123456789:${'A'.repeat(35)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Telegram pack links and Bot API downloads', () => {
  it('bypasses the service worker only for the HTTPS Telegram Bot API origin', () => {
    expect(isTelegramBotApiUrl('https://api.telegram.org')).toBe(true);
    expect(isTelegramBotApiUrl('https://api.telegram.org/bot123/method')).toBe(true);
    expect(isTelegramBotApiUrl('https://api.telegram.org.evil.example/x')).toBe(false);
    expect(isTelegramBotApiUrl('https://api.telegram.org@evil.example/')).toBe(false);
    expect(isTelegramBotApiUrl('http://api.telegram.org/')).toBe(false);
  });

  it('parses only a public Telegram sticker or custom emoji pack link and rebuilds its source', () => {
    expect(parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')).toEqual({
      name: 'Cats_2',
      type: 'stickers',
      source: 'https://t.me/addstickers/Cats_2'
    });
    expect(parseTelegramStickerPackLink('https://t.me/addemoji/Faces_2')).toEqual({
      name: 'Faces_2',
      type: 'emoji',
      source: 'https://t.me/addemoji/Faces_2'
    });
    expect(parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2?start=secret')).toBeUndefined();
    expect(parseTelegramStickerPackLink('https://evil.example/addstickers/Cats_2')).toBeUndefined();
    expect(parseTelegramStickerPackLink('https://t.me/addstickers/Cats%2F2')).toBeUndefined();
    expect(parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2/extra')).toBeUndefined();
  });

  it('checks the bot token shape before making a Bot API request', async() => {
    const fetchMock = mockTelegramFetch(() => {
      throw new Error('should not request Telegram with an invalid token');
    });
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;

    expect(isValidTelegramBotToken(token)).toBe(true);
    expect(isValidTelegramBotToken('123456789:too-short')).toBe(false);
    await expect(downloadTelegramStickerPack(link, '123456789:too-short')).rejects.toThrow(/valid Telegram bot token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads a sticker pack in order with its emojis and safe request options', async() => {
    const requests: Array<{url: URL, init?: RequestInit}> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({url, init});
      if(url.pathname.endsWith('/getStickerSet')) {
        return Promise.resolve(makeJsonResponse(url.toString(), {
          ok: true,
          result: {
            name: 'Cats_2',
            title: 'Telegram Cats',
            sticker_type: 'regular',
            stickers: [{
              file_id: 'telegram-file-1',
              file_unique_id: 'telegram-unique-1',
              type: 'regular',
              width: 512,
              height: 512,
              is_animated: false,
              is_video: false,
              emoji: '🐈',
              file_size: 3
            }]
          }
        }));
      }
      if(url.pathname.endsWith('/getFile')) {
        return Promise.resolve(makeJsonResponse(url.toString(), {
          ok: true,
          result: {file_id: 'telegram-file-1', file_unique_id: 'telegram-unique-1', file_size: 3, file_path: 'stickers/cat.webp'}
        }));
      }
      return Promise.resolve(makeFileResponse(url.toString(), [5, 6, 7]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const progress: Array<{current: number, total: number}> = [];
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;

    const result = await downloadTelegramStickerPack(link, token, (value) => progress.push(value));

    expect(result.title).toBe('Telegram Cats');
    expect(result.type).toBe('stickers');
    expect(result.source).toBe('https://t.me/addstickers/Cats_2');
    expect(result.files.map((file) => file.name)).toEqual(['sticker-001.webp']);
    expect(Array.from(new Uint8Array(await result.files[0].arrayBuffer()))).toEqual([5, 6, 7]);
    expect(result.emojis).toEqual(['🐈']);
    expect(progress).toEqual([{current: 1, total: 1}]);
    expect(requests.map(({url}) => url.origin)).toEqual([
      'https://api.telegram.org',
      'https://api.telegram.org',
      'https://api.telegram.org'
    ]);
    expect(requests.map(({url}) => url.pathname.endsWith('/getStickerSet') ? url.searchParams.get('name') : undefined))
    .toEqual(['Cats_2', undefined, undefined]);
    expect(requests.every(({init}) =>
      init?.credentials === 'omit' &&
      init.referrerPolicy === 'no-referrer' &&
      init.cache === 'no-store' &&
      init.redirect === 'error'
    )).toBe(true);
  });

  it('uses getCustomEmojiStickers and restores the pack order after Telegram returns another order', async() => {
    const requests: URL[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      if(url.pathname.endsWith('/getStickerSet')) {
        return Promise.resolve(makeJsonResponse(url.toString(), {
          ok: true,
          result: {
            name: 'Faces_2',
            title: 'Telegram Faces',
            sticker_type: 'custom_emoji',
            stickers: [
              {custom_emoji_id: 'emoji-a', emoji: '😀'},
              {custom_emoji_id: 'emoji-b', emoji: '😺'}
            ]
          }
        }));
      }
      if(url.pathname.endsWith('/getCustomEmojiStickers')) {
        return Promise.resolve(makeJsonResponse(url.toString(), {
          ok: true,
          result: [
            {custom_emoji_id: 'emoji-b', file_id: 'file-b', emoji: '😺'},
            {custom_emoji_id: 'emoji-a', file_id: 'file-a', emoji: '😀'}
          ]
        }));
      }
      if(url.pathname.endsWith('/getFile')) {
        const fileId = url.searchParams.get('file_id');
        const filePath = fileId === 'file-a' ? 'stickers/one.tgs' : 'stickers/two.webp';
        return Promise.resolve(makeJsonResponse(url.toString(), {
          ok: true,
          result: {file_id: fileId, file_unique_id: fileId, file_size: 3, file_path: filePath}
        }));
      }
      return Promise.resolve(makeFileResponse(url.toString(), [1, 2, 3]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const link = parseTelegramStickerPackLink('https://t.me/addemoji/Faces_2')!;

    const result = await downloadTelegramStickerPack(link, token);

    expect(result.type).toBe('emoji');
    expect(result.files.map((file) => file.name)).toEqual(['sticker-001.tgs', 'sticker-002.webp']);
    expect(result.emojis).toEqual(['😀', '😺']);
    expect(requests.some((url) => url.pathname.endsWith('/getCustomEmojiStickers'))).toBe(true);
    expect(requests.map((url) => url.searchParams.get('file_id')).filter(Boolean)).toEqual(['file-a', 'file-b']);
  });

  it('shows Telegram error descriptions with the bot token redacted', async() => {
    const fetchMock = mockTelegramFetch((url) => makeJsonResponse(url.toString(), {
      ok: false,
      description: `Unauthorized ${token}`
    }, 401));
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;

    await expect(downloadTelegramStickerPack(link, token)).rejects.toThrow('Unauthorized [redacted]');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['../private.webp', 'https://evil.example/file.webp', '/absolute.webp'])('rejects an unsafe Telegram file path: %s', async(filePath) => {
    const fetchMock = mockTelegramFetch((url) => {
      if(url.pathname.endsWith('/getStickerSet')) {
        return makeJsonResponse(url.toString(), {
          ok: true,
          result: {name: 'Cats_2', title: 'Cats', sticker_type: 'regular', stickers: [{file_id: 'file-1', emoji: '🐈'}]}
        });
      }
      return makeJsonResponse(url.toString(), {ok: true, result: {file_id: 'file-1', file_path: filePath}});
    });
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;

    await expect(downloadTelegramStickerPack(link, token)).rejects.toThrow(/file path/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses an oversized sticker before downloading its bytes', async() => {
    const fetchMock = mockTelegramFetch((url) => {
      if(url.pathname.endsWith('/getStickerSet')) {
        return makeJsonResponse(url.toString(), {
          ok: true,
          result: {name: 'Cats_2', title: 'Cats', sticker_type: 'regular', stickers: [{file_id: 'file-1', emoji: '🐈'}]}
        });
      }
      return makeJsonResponse(url.toString(), {
        ok: true,
        result: {file_id: 'file-1', file_size: 512 * 1024 + 1, file_path: 'stickers/cat.webp'}
      });
    });
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;

    await expect(downloadTelegramStickerPack(link, token)).rejects.toThrow(/too large/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a Telegram emoji pack with 202 stickers before downloading files', async() => {
    const fetchMock = mockTelegramFetch((url) => makeJsonResponse(url.toString(), {
      ok: true,
      result: {name: 'Faces_2', title: 'Faces', sticker_type: 'custom_emoji', stickers: Array.from({length: 202}, () => ({}))}
    }));
    const link = parseTelegramStickerPackLink('https://t.me/addemoji/Faces_2')!;

    await expect(downloadTelegramStickerPack(link, token)).rejects.toThrow(/too many stickers/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a Bot API response whose final URL has another origin', async() => {
    const fetchMock = mockTelegramFetch((url) => makeJsonResponse('https://evil.example/getStickerSet', {
      ok: true,
      result: {name: 'Cats_2', title: 'Cats', sticker_type: 'regular', stickers: []}
    }));
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;

    await expect(downloadTelegramStickerPack(link, token)).rejects.toThrow(/response host/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('Telegram sticker pack upload boundary', () => {
  it('keeps a token-bearing import out of every Teagram request through the actual upload manager', async() => {
    const importToken = `123456789:${'C'.repeat(35)}`;
    const telegramRequests: URL[] = [];
    const telegramFetch = mockTelegramFetch((url) => {
      telegramRequests.push(url);
      if(url.pathname.endsWith('/getStickerSet')) {
        return makeJsonResponse(url.toString(), {
          ok: true,
          result: {
            name: 'Cats_2',
            title: 'Telegram Cats',
            sticker_type: 'regular',
            stickers: [{file_id: 'telegram-file-1', emoji: '🐈'}]
          }
        });
      }
      if(url.pathname.endsWith('/getFile')) {
        return makeJsonResponse(url.toString(), {
          ok: true,
          result: {file_id: 'telegram-file-1', file_path: 'stickers/cat.webp', file_size: 3}
        });
      }
      return makeFileResponse(url.toString(), [5, 6, 7]);
    });
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;
    const downloadedPack = await downloadTelegramStickerPack(link, importToken);
    const teagramRequests: Array<{method: string, params: Record<string, any>}> = [];
    const uploadCalls: Array<Record<string, unknown>> = [];
    const manager = {
      appPeersManager: {getInputPeerSelf: () => ({_: 'inputPeerSelf'})},
      apiFileManager: {upload: vi.fn(async(options: Record<string, any>) => {
        uploadCalls.push(options);
        return {_:'inputFile', id: 1, parts: 1, name: options.file.name, md5_checksum: ''};
      })},
      apiManager: {
        invokeApi: vi.fn(async(method: string, params: Record<string, any>) => {
          teagramRequests.push({method, params});
          if(method === 'messages.uploadMedia') {
            return {
              _: 'messageMediaDocument',
              document: {
                _: 'document',
                id: '100',
                access_hash: '200',
                file_reference: new Uint8Array([1]),
                date: 0,
                mime_type: 'image/webp',
                size: 3,
                dc_id: 1,
                attributes: []
              }
            };
          }
          return true;
        })
      },
      appDocsManager: {saveDoc: (document: any) => document},
      appUsersManager: {getSelf: () => ({id: '42'}), getUserInput: (id: string) => ({_: 'inputUser', user_id: id})}
    };

    expect(await AppStickersManager.prototype.checkStickerSetShortName.call(manager as any, 'telegram_cats')).toBe(true);
    await AppStickersManager.prototype.createStickerSet.call(
      manager as any,
      getTelegramStickerPackUploadOptions(downloadedPack, 'telegram_cats')
    );

    expect(telegramFetch).toHaveBeenCalledTimes(3);
    expect(telegramRequests.every(({origin}) => origin === 'https://api.telegram.org')).toBe(true);
    expect(telegramRequests.some(({pathname}) => pathname.includes(importToken))).toBe(true);
    expect(teagramRequests.map(({method}) => method)).toEqual([
      'stickers.checkShortName',
      'messages.uploadMedia',
      'stickers.createStickerSet'
    ]);
    expect(manager.apiFileManager.upload).toHaveBeenCalledOnce();
    expect(JSON.stringify({teagramRequests, uploadCalls})).not.toContain(importToken);

    const createRequest = teagramRequests.find(({method}) => method === 'stickers.createStickerSet');
    expect(createRequest?.params.software).toBe('https://t.me/addstickers/Cats_2');
    expect(createRequest?.params.stickers.map((sticker: {emoji: string}) => sticker.emoji)).toEqual(['🐈']);
  });
});
