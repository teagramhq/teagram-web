import type {ActiveAccountNumber} from '@lib/accounts/types';
import {isValidTelegramBotToken} from '@config/telegramBotApi';
import apiManagerProxy from '@lib/apiManagerProxy';

const TOKEN_STORAGE_MANAGER = 'telegramStickerPackTokenStorageManager';

export async function getSavedTelegramBotToken(accountNumber: ActiveAccountNumber) {
  const token = await apiManagerProxy.invoke('singleManager', {
    name: TOKEN_STORAGE_MANAGER,
    method: 'getSavedTelegramBotToken',
    args: [accountNumber]
  });
  return typeof token === 'string' && isValidTelegramBotToken(token) ? token : undefined;
}

export async function saveTelegramBotToken(accountNumber: ActiveAccountNumber, token: string) {
  if(!isValidTelegramBotToken(token)) throw new Error('Enter a valid Telegram bot token.');
  await apiManagerProxy.invoke('singleManager', {
    name: TOKEN_STORAGE_MANAGER,
    method: 'saveTelegramBotToken',
    args: [accountNumber, token]
  });
}

export async function removeTelegramBotToken(accountNumber: ActiveAccountNumber) {
  await apiManagerProxy.invoke('singleManager', {
    name: TOKEN_STORAGE_MANAGER,
    method: 'removeTelegramBotToken',
    args: [accountNumber]
  });
}
