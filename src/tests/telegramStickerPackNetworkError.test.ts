import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const logState = vi.hoisted(() => ({warnings: [] as unknown[][]}));

vi.mock('@lib/logger', () => ({
  logger: (): any => {
    const mockLogger: any = (): void => undefined;
    mockLogger.warn = (...args: unknown[]) => { logState.warnings.push(args); };
    mockLogger.error = (): void => undefined;
    mockLogger.info = (): void => undefined;
    mockLogger.debug = (): void => undefined;
    mockLogger.trace = (): void => undefined;
    mockLogger.assert = (): void => undefined;
    mockLogger.group = (): void => undefined;
    mockLogger.groupCollapsed = (): void => undefined;
    mockLogger.groupEnd = (): void => undefined;
    mockLogger.setPrefix = (): void => undefined;
    mockLogger.setLevel = (): void => undefined;
    mockLogger.bindPrefix = () => mockLogger;
    return mockLogger;
  }
}));

import {downloadTelegramStickerPack, parseTelegramStickerPackLink} from '@helpers/telegramStickerPackImport';

const token = `123456789:${'A'.repeat(35)}`;

function jsonResponse(url: URL, result: unknown) {
  const response = new Response(JSON.stringify({ok: true, result}), {
    status: 200,
    headers: {'Content-Type': 'application/json'}
  });
  Object.defineProperty(response, 'url', {value: url.toString()});
  return response;
}

beforeEach(() => {
  logState.warnings.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Telegram Bot API network errors', () => {
  it('explains that the browser could not reach the Bot API and logs only the error name', async() => {
    const failure = new TypeError(`CORS blocked ${token} at https://api.telegram.org/bot${token}/getStickerSet`);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;

    await expect(downloadTelegramStickerPack(link, token)).rejects.toThrow(/browser could not reach api\.telegram\.org/i);

    expect(logState.warnings).toEqual([['Could not reach Telegram Bot API', 'TypeError']]);
    expect(JSON.stringify(logState.warnings)).not.toContain(token);
  });

  it('logs a file-download rejection without including its token-bearing request URL', async() => {
    const failure = new TypeError(`network blocked ${token}`);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if(url.pathname.endsWith('/getStickerSet')) {
        return Promise.resolve(jsonResponse(url, {
          name: 'Cats_2',
          title: 'Cats',
          sticker_type: 'regular',
          stickers: [{file_id: 'file-1', emoji: '🐈'}]
        }));
      }
      if(url.pathname.endsWith('/getFile')) {
        return Promise.resolve(jsonResponse(url, {file_id: 'file-1', file_path: 'stickers/cat.webp', file_size: 3}));
      }
      return Promise.reject(failure);
    });
    vi.stubGlobal('fetch', fetchMock);
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;

    await expect(downloadTelegramStickerPack(link, token)).rejects.toThrow(/browser could not reach api\.telegram\.org/i);

    expect(logState.warnings).toEqual([['Could not download Telegram sticker file', 'TypeError']]);
    expect(JSON.stringify(logState.warnings)).not.toContain(token);
  });

  it('logs a failed sticker response stream by error name only', async() => {
    const failure = new TypeError(`stream failed ${token}`);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if(url.pathname.endsWith('/getStickerSet')) {
        return Promise.resolve(jsonResponse(url, {
          name: 'Cats_2',
          title: 'Cats',
          sticker_type: 'regular',
          stickers: [{file_id: 'file-1', emoji: '🐈'}]
        }));
      }
      if(url.pathname.endsWith('/getFile')) {
        return Promise.resolve(jsonResponse(url, {file_id: 'file-1', file_path: 'stickers/cat.webp', file_size: 3}));
      }

      const response = new Response(null);
      Object.defineProperty(response, 'url', {value: url.toString()});
      Object.defineProperty(response, 'body', {value: {getReader: () => ({read: () => Promise.reject(failure)})}});
      return Promise.resolve(response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const link = parseTelegramStickerPackLink('https://t.me/addstickers/Cats_2')!;

    await expect(downloadTelegramStickerPack(link, token)).rejects.toThrow(/browser could not reach api\.telegram\.org/i);

    expect(logState.warnings).toEqual([['Could not read Telegram sticker download', 'TypeError']]);
    expect(JSON.stringify(logState.warnings)).not.toContain(token);
  });
});
