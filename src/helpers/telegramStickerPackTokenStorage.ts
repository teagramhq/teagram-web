import {getDatabaseState} from '@config/databases/state';
import type {AccountDatabase} from '@config/databases/state';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import AppStorage from '@lib/storage';
import {isValidTelegramBotToken} from '@helpers/telegramStickerPackImport';

const TOKEN_KEY = 'telegramBotToken';

type TelegramTokenStorage = AppStorage<Record<string, string>, AccountDatabase>;

const storages = new Map<string, TelegramTokenStorage>();

function getTokenStorage(accountNumber: ActiveAccountNumber) {
  const database = getDatabaseState(accountNumber);
  let storage = storages.get(database.name);
  if(!storage) {
    storage = new AppStorage(database, 'session', [TOKEN_KEY]);
    storages.set(database.name, storage);
  }

  return storage;
}

export async function getSavedTelegramBotToken(accountNumber: ActiveAccountNumber) {
  const token = await getTokenStorage(accountNumber).get(TOKEN_KEY, false);
  return typeof token === 'string' && isValidTelegramBotToken(token) ? token : undefined;
}

export async function saveTelegramBotToken(accountNumber: ActiveAccountNumber, token: string) {
  if(!isValidTelegramBotToken(token)) throw new Error('Enter a valid Telegram bot token.');
  await getTokenStorage(accountNumber).set({[TOKEN_KEY]: token});
}

export async function removeTelegramBotToken(accountNumber: ActiveAccountNumber) {
  await getTokenStorage(accountNumber).delete(TOKEN_KEY);
}
