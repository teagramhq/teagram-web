export const TELEGRAM_BOT_API_ORIGIN = 'https://api.telegram.org';

const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/;

export function isValidTelegramBotToken(token: string) {
  return BOT_TOKEN_PATTERN.test(token);
}

export function isTelegramBotApiUrl(value: string) {
  return value === TELEGRAM_BOT_API_ORIGIN || value.startsWith(`${TELEGRAM_BOT_API_ORIGIN}/`);
}
