import type {ActiveAccountNumber} from '@lib/accounts/types';
import type {ChatPageKey, ChatPageRow} from '@lib/chatPageSnapshot';

export function paintChatPageSnapshotSafely(
  readRows: () => ChatPageRow[] | undefined,
  paint: (rows: ChatPageRow[] | undefined) => void,
  clear: () => void
) {
  try {
    paint(readRows());
  } catch(error) {
    console.error('Could not paint the chat page snapshot', error);
    try {
      clear();
    } catch(clearError) {
      console.error('Could not remove the failed chat page snapshot', clearError);
    }
  }
}

export async function paintGuestChatPageSnapshotIfCurrent(dependencies: {
  accountNumber: ActiveAccountNumber,
  serverHost?: string,
  serverId: string,
  wipeGeneration?: string,
  isSnapshotIdentityCurrent: () => Promise<boolean>,
  getChatPageKey: (accountNumber: ActiveAccountNumber) => Promise<ChatPageKey | undefined>,
  getCurrentAccountNumber: () => ActiveAccountNumber,
  getActiveServerHost: () => string | undefined,
  getRuntimeServerId: () => string,
  getActiveDemoWipeGeneration: () => string | undefined,
  readSnapshot: (key: ChatPageKey) => ChatPageRow[] | undefined,
  paint: (rows: ChatPageRow[] | undefined) => void,
  clear: () => void
}) {
  let key: ChatPageKey | undefined;
  try {
    if(!await dependencies.isSnapshotIdentityCurrent()) return;
    key = await dependencies.getChatPageKey(dependencies.accountNumber);
    if(!key || dependencies.accountNumber !== dependencies.getCurrentAccountNumber() ||
      dependencies.serverHost !== dependencies.getActiveServerHost() ||
      dependencies.serverId !== dependencies.getRuntimeServerId() ||
      dependencies.wipeGeneration !== dependencies.getActiveDemoWipeGeneration()) return;
  } catch(error) {
    console.error('Could not verify the guest session before painting the chat snapshot', error);
    return;
  }

  paintChatPageSnapshotSafely(() => dependencies.readSnapshot(key), dependencies.paint, dependencies.clear);
}
