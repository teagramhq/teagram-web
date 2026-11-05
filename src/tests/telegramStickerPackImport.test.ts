import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {getSavedTelegramBotToken, removeTelegramBotToken, saveTelegramBotToken} from '@helpers/telegramStickerPackTokenStorage';
import {downloadTelegramStickerPack, isValidTelegramBotToken, parseTelegramStickerPackLink} from '@helpers/telegramStickerPackImport';
import {AppStickersManager} from '@appManagers/appStickersManager';
import AccountController from '@lib/accounts/accountController';
import {getDatabaseState} from '@config/databases/state';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import IDBStorage from '@lib/files/idb';
import appSessionStorage from '@lib/sessionStorage';
import type {ValidatedStickerPackFiles} from '@helpers/stickerPackCommon';

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

beforeAll(() => {
  DeferredIsUsingPasscode.resolveDeferred(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Telegram pack links and Bot API downloads', () => {
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

describe('Telegram bot token storage', () => {
  const accountNumber = 4;
  const tokenKey = `telegramBotToken${accountNumber}`;
  const savedToken = `987654321:${'B'.repeat(35)}`;

  const createEncryptedStorage = (initialEntries: Record<string, unknown> = {}, beforeFlush = async() => {}) => {
    const persisted = new Map(Object.entries(initialEntries));
    const pending = new Map(persisted);
    const proxy = vi.spyOn(appSessionStorage, 'encryptedStorageProxy') as any;
    proxy.mockImplementation(async(type: string, ...args: any[]) => {
      if(type === 'get') {
        const [keys, useCache = true] = args as [string[], boolean?];
        const source = useCache ? pending : persisted;
        return keys.map((key) => source.get(key));
      }

      if(type === 'save') {
        const [keys, values] = args as [string[], unknown[]];
        keys.forEach((key, index) => pending.set(key, values[index]));
        return;
      }

      if(type === 'delete') {
        const names = Array.isArray(args[0]) ? args[0] : [args[0]];
        names.forEach((key) => pending.delete(key));
        return;
      }

      if(type === 'flush') {
        await beforeFlush();
        persisted.clear();
        pending.forEach((value, key) => persisted.set(key, value));
      }
    });

    return {
      proxy,
      persisted,
      simulateReload() {
        pending.clear();
        persisted.forEach((value, key) => pending.set(key, value));
      }
    };
  };

  const clearTestToken = async() => {
    DeferredIsUsingPasscode.resolveDeferred(false);
    await appSessionStorage.localStorageProxy('delete', tokenKey);
    await new IDBStorage(getDatabaseState(accountNumber), 'session').delete('telegramBotToken');
  };

  beforeEach(clearTestToken);

  afterEach(async() => {
    DeferredIsUsingPasscode.resolveDeferred(false);
    vi.restoreAllMocks();
    await clearTestToken();
  });

  it('writes through encrypted session storage when a passcode is enabled after the import flow opens', async() => {
    DeferredIsUsingPasscode.resolveDeferred(false);
    expect(await getSavedTelegramBotToken(accountNumber)).toBeUndefined();

    const encryptedStorage = createEncryptedStorage();
    DeferredIsUsingPasscode.resolveDeferred(true);
    await saveTelegramBotToken(accountNumber, savedToken);

    expect(encryptedStorage.proxy).toHaveBeenCalledWith('save', [tokenKey], [savedToken]);
    expect(encryptedStorage.proxy).toHaveBeenCalledWith('flush');
    expect(await appSessionStorage.localStorageProxy('get', tokenKey, false)).toBeUndefined();
    expect(await getSavedTelegramBotToken(accountNumber)).toBe(savedToken);
  });

  it('waits for encrypted deletion to flush and reads the token as absent after reload', async() => {
    let startedFlush!: () => void;
    const flushStarted = new Promise<void>((resolve) => { startedFlush = resolve; });
    let finishFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { finishFlush = resolve; });
    const encryptedStorage = createEncryptedStorage({[tokenKey]: savedToken}, async() => {
      startedFlush();
      await flushGate;
    });
    DeferredIsUsingPasscode.resolveDeferred(true);

    const removal = removeTelegramBotToken(accountNumber);
    const firstResult = await Promise.race([
      removal.then(() => 'removed', () => 'failed'),
      flushStarted.then(() => 'flushing')
    ]);
    expect(firstResult).toBe('flushing');
    await flushStarted;
    let settled = false;
    void removal.then(() => { settled = true; }, () => { settled = true; });
    expect(settled).toBe(false);

    finishFlush();
    await removal;
    encryptedStorage.simulateReload();

    expect(encryptedStorage.persisted.has(tokenKey)).toBe(false);
    expect(await getSavedTelegramBotToken(accountNumber)).toBeUndefined();
  });

  it('propagates encrypted flush failures and preserves the saved token after reload', async() => {
    const encryptedStorage = createEncryptedStorage({[tokenKey]: savedToken}, async() => {
      throw new Error('encrypted session storage flush failed');
    });
    DeferredIsUsingPasscode.resolveDeferred(true);

    await expect(removeTelegramBotToken(accountNumber)).rejects.toThrow('encrypted session storage flush failed');
    encryptedStorage.simulateReload();

    expect(await getSavedTelegramBotToken(accountNumber)).toBe(savedToken);
  });

  it('reports a plaintext removal failure if storage still returns the token', async() => {
    DeferredIsUsingPasscode.resolveDeferred(false);
    await saveTelegramBotToken(accountNumber, savedToken);
    const localStorageProxy = appSessionStorage.localStorageProxy.bind(appSessionStorage);
    vi.spyOn(appSessionStorage, 'localStorageProxy').mockImplementation(async(type, ...args) => {
      if(type === 'delete' && args[0] === tokenKey) return undefined as any;
      return localStorageProxy(type, ...args);
    });

    await expect(removeTelegramBotToken(accountNumber)).rejects.toThrow(/remove/i);
    expect(await getSavedTelegramBotToken(accountNumber)).toBe(savedToken);
  });

  it('clears the saved token when its account is logged out', async() => {
    await saveTelegramBotToken(accountNumber, savedToken);
    await AccountController.shiftAccounts(accountNumber);

    expect(await getSavedTelegramBotToken(accountNumber)).toBeUndefined();
  });

  it('moves saved tokens with accounts when logout shifts account slots', async() => {
    DeferredIsUsingPasscode.resolveDeferred(false);
    const account3TokenKey = 'telegramBotToken3';
    const account3 = await appSessionStorage.get('account3', false);
    const account4 = await appSessionStorage.get('account4', false);
    const account3Token = await appSessionStorage.get(account3TokenKey as any, false);
    const account4Token = await appSessionStorage.get(tokenKey as any, false);

    try {
      await AccountController.update(3, {userId: 300 as PeerId}, true);
      await AccountController.update(4, {userId: 400 as PeerId}, true);
      await saveTelegramBotToken(accountNumber, savedToken);
      await AccountController.shiftAccounts(3);

      expect(await getSavedTelegramBotToken(3)).toBe(savedToken);
      expect(await getSavedTelegramBotToken(4)).toBeUndefined();
    } finally {
      const keys = ['account3', 'account4', account3TokenKey, tokenKey];
      await Promise.all(keys.map((key) => appSessionStorage.localStorageProxy('delete', key)));
      const values: Record<string, unknown> = {};
      if(account3 !== undefined) values.account3 = account3;
      if(account4 !== undefined) values.account4 = account4;
      if(account3Token !== undefined) values[account3TokenKey] = account3Token;
      if(account4Token !== undefined) values[tokenKey] = account4Token;
      if(Object.keys(values).length) await appSessionStorage.localStorageProxy('set', values);
    }
  });
});

describe('Telegram sticker pack upload boundary', () => {
  it('sends the canonical source and original emojis to Teagram without the bot token', async() => {
    const token = `123456789:${'C'.repeat(35)}`;
    const apiRequests: Array<{method: string, params: Record<string, any>}> = [];
    const file = new File([Uint8Array.from([5, 6, 7])], 'sticker-001.webp', {type: 'image/webp'});
    const manager = {
      appPeersManager: {getInputPeerSelf: () => ({_: 'inputPeerSelf'})},
      apiFileManager: {upload: vi.fn(async() => ({_: 'inputFile', id: 1, parts: 1, name: file.name, md5_checksum: ''}))},
      apiManager: {
        invokeApi: vi.fn(async(method: string, params: Record<string, any>) => {
          apiRequests.push({method, params});
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

    await AppStickersManager.prototype.createStickerSet.call(manager as any, {
      files: [file] as ValidatedStickerPackFiles,
      title: 'Telegram Cats',
      shortName: 'telegram_cats',
      isEmoji: false,
      software: 'https://t.me/addstickers/Cats_2',
      emojis: ['🐈']
    });

    const createRequest = apiRequests.find(({method}) => method === 'stickers.createStickerSet');
    expect(createRequest?.params.software).toBe('https://t.me/addstickers/Cats_2');
    expect(createRequest?.params.stickers.map((sticker: {emoji: string}) => sticker.emoji)).toEqual(['🐈']);
    expect(JSON.stringify(apiRequests)).not.toContain(token);
  });
});
