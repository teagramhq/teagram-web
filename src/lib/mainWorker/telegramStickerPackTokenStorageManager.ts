import type {AccountDatabase} from '@config/databases/state';
import {getDatabaseState} from '@config/databases/state';
import {isValidTelegramBotToken} from '@config/telegramBotApi';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import AppStorage from '@lib/storage';

type TelegramBotTokenSession = Record<string, unknown> & {telegramBotToken?: string};

export class TelegramStickerPackTokenStorageManager {
  public name = 'telegramStickerPackTokenStorageManager';

  private storages = new Map<ActiveAccountNumber, AppStorage<TelegramBotTokenSession, AccountDatabase>>();

  private getStorage(accountNumber: ActiveAccountNumber) {
    let storage = this.storages.get(accountNumber);
    if(!storage) {
      storage = new AppStorage<TelegramBotTokenSession, AccountDatabase>(
        getDatabaseState(accountNumber),
        'session',
        ['telegramBotToken']
      );
      this.storages.set(accountNumber, storage);
    }

    return storage;
  }

  public async getSavedTelegramBotToken(accountNumber: ActiveAccountNumber) {
    const token = await this.getStorage(accountNumber).get('telegramBotToken', false);
    return typeof token === 'string' && isValidTelegramBotToken(token) ? token : undefined;
  }

  public async saveTelegramBotToken(accountNumber: ActiveAccountNumber, token: string) {
    if(!isValidTelegramBotToken(token)) throw new Error('Enter a valid Telegram bot token.');

    const storage = this.getStorage(accountNumber);
    await storage.set({telegramBotToken: token});
    await storage.flush();
    if(!storage.isAvailable()) throw new Error('Could not save the Telegram bot token.');
  }

  public async removeTelegramBotToken(accountNumber: ActiveAccountNumber) {
    const storage = this.getStorage(accountNumber);
    await storage.delete('telegramBotToken');
    await storage.flush();

    if(await storage.get('telegramBotToken', false) !== undefined) {
      throw new Error('Could not remove the saved Telegram bot token.');
    }
  }
}

export default new TelegramStickerPackTokenStorageManager();
