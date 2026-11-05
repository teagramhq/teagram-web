export const TELEGRAM_BOT_API_ORIGIN = 'https://api.telegram.org';

export function isTelegramBotApiUrl(value: string) {
  return value === TELEGRAM_BOT_API_ORIGIN || value.startsWith(`${TELEGRAM_BOT_API_ORIGIN}/`);
}
