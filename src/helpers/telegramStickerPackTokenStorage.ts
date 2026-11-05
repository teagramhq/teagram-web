import type {ActiveAccountNumber} from '@lib/accounts/types';
import {isValidTelegramBotToken} from '@helpers/telegramStickerPackImport';
import sessionStorage, {getTelegramBotTokenStorageKey} from '@lib/sessionStorage';
import type {TelegramBotTokenStorageKey} from '@lib/sessionStorage';

export async function getSavedTelegramBotToken(accountNumber: ActiveAccountNumber) {
  const token = await sessionStorage.get(getTelegramBotTokenStorageKey(accountNumber), false);
  return typeof token === 'string' && isValidTelegramBotToken(token) ? token : undefined;
}

export async function saveTelegramBotToken(accountNumber: ActiveAccountNumber, token: string) {
  if(!isValidTelegramBotToken(token)) throw new Error('Enter a valid Telegram bot token.');
  const values: Partial<Record<TelegramBotTokenStorageKey, string>> = {
    [getTelegramBotTokenStorageKey(accountNumber)]: token
  };
  await sessionStorage.set(values);
  await sessionStorage.flush();
}

export async function removeTelegramBotToken(accountNumber: ActiveAccountNumber) {
  const key = getTelegramBotTokenStorageKey(accountNumber);
  await sessionStorage.delete(key);
  await sessionStorage.flush();

  if(await sessionStorage.get(key, false) !== undefined) {
    throw new Error('Could not remove the saved Telegram bot token.');
  }
}
