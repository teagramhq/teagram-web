import type {EmojiStatus, User} from '@layer';
import type {AccountEmojiStatuses} from '@layer';
import {logger} from '@lib/logger';

const log = logger('SidebarEmojiStatus');

export async function optionalStatuses(promise: Promise<AccountEmojiStatuses>): Promise<AccountEmojiStatuses | undefined> {
  try {
    return await promise;
  } catch(error) {
    if((error as {type?: string})?.type !== 'INPUT_METHOD_INVALID') {
      log.error('Optional emoji status list failed', error);
    }
    return undefined;
  }
}

export function getSidebarEmojiStatus(user: User | null | undefined): EmojiStatus.emojiStatus | undefined {
  if(!user || user._ === 'userEmpty') {
    throw new Error('Current user is unavailable while rendering emoji status');
  }

  return user.emoji_status as EmojiStatus.emojiStatus;
}

export async function updateSidebarEmojiStatus(
  update: () => Promise<void>,
  reportError: (error: unknown) => void
) {
  try {
    await update();
  } catch(error) {
    reportError(error);
  }
}
