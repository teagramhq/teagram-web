import type {EmojiStatus, User} from '@layer';

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
