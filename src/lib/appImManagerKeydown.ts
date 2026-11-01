import {ChatType} from '@components/chat/chatType';
import IS_TOUCH_SUPPORTED from '@environment/touchSupport';
import cancelEvent from '@helpers/dom/cancelEvent';
import mediaSizes from '@helpers/mediaSizes';
import overlayCounter from '@helpers/overlayCounter';
import type {AppDialogsManager} from '@lib/appDialogsManager';
import type {AppImManager} from '@lib/appImManager';

type KeydownManager = Pick<AppImManager, 'chat' | 'isShiftLockShortcut' | 'managers' | 'setPeer'>;
type KeydownDialogsManager = Pick<AppDialogsManager, 'contextMenu' | 'filterId'>;

export default function createAppImManagerKeydownHandler(
  manager: KeydownManager,
  dialogsManager: KeydownDialogsManager,
  isChatTab: () => boolean
) {
  const IGNORE_KEYS = new Set(['Meta', 'Control']);

  return async(e: KeyboardEvent) => {
    const key = e.key;
    const isSelectionCollapsed = document.getSelection().isCollapsed;
    if(
      overlayCounter.isOverlayActive ||
      IGNORE_KEYS.has(key) ||
      !e.isTrusted // * ignore synthetic events
    ) return;

    const target = e.target as HTMLElement;

    const isTargetAnInput = (target.tagName === 'INPUT' && !['checkbox', 'radio'].includes((target as HTMLInputElement).type)) || target.isContentEditable;

    const chat = manager.chat;

    // Hand keyboard focus to the bubbles scroll container so the browser scrolls it natively.
    // (overflow:auto + outline:none → focus is invisible.)
    const handoffScroll = () => {
      const container = chat?.bubbles?.scrollable?.container;
      if(container && document.activeElement !== container) {
        container.focus({preventScroll: true});
      }
    };

    if(manager.isShiftLockShortcut && e.shiftKey) return;

    if((key.startsWith('Arrow') || (e.shiftKey && key === 'Shift')) && !isSelectionCollapsed) {
      return;
    } else if(e.code === 'KeyC' && (e.ctrlKey || e.metaKey) && !isTargetAnInput) {
      return;
    } else if(
      (key === 'PageUp' || key === 'PageDown') &&
      !isTargetAnInput &&
      !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
    ) {
      handoffScroll();
      return;
    } else if(e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      cancelEvent(e);
      manager.managers.dialogsStorage.getNextDialog(
        manager.chat?.peerId,
        key === 'ArrowDown',
        dialogsManager.filterId
      ).then((dialog) => {
        if(dialog) {
          manager.setPeer({peerId: dialog.peerId});
        }
      });
      return;
    } else if((key === 'ArrowUp' || key === 'ArrowDown') && chat && chat.type !== ChatType.Scheduled) {
      // In chats/channels where the user can't post (read-only broadcasts, restricted groups,
      // unjoined chats), there's no message to edit, so let ArrowUp/Down scroll the chat instead.
      if(chat?.input && !chat.input.canSendPlain()) {
        handoffScroll();
        return;
      }

      if(
        !dialogsManager.contextMenu?.hasAddToFolderOpen() &&
        !chat?.input?.editMsgId
      ) {
        const forReply = e.metaKey || e.ctrlKey;
        if(!forReply && !chat?.input?.isInputEmpty()) {
          return;
        }

        const up = key === 'ArrowUp';
        const {replyToMsgId} = chat.input;
        const {peerId, threadId} = chat;
        if((!forReply && !up) || (forReply && !up && !replyToMsgId)) {
          return;
        }

        cancelEvent(e);
        const middleware = chat.bubbles.getMiddleware();
        if(forReply && !(await chat.canSend())) {
          return;
        }

        if(!middleware()) {
          return;
        }

        manager.managers.appMessagesManager.getFirstMessageToEdit({
          peerId,
          threadId,
          forReply,
          mid: forReply ? replyToMsgId : undefined,
          up
        }).then(async(message) => {
          if(chat !== manager.chat || !middleware()) {
            return;
          }

          if(!message) {
            if(forReply && chat.input.replyToMsgId === replyToMsgId) {
              chat.input.onHelperCancel();
            }

            return;
          }

          if(forReply) {
            const bubble = chat.bubbles.getBubble(message.peerId, message.mid);
            await chat.input.initMessageReply(chat.input.getChatInputReplyToFromMessage(message));
            if(bubble) {
              chat.bubbles.scrollToBubble(bubble, 'center');
              chat.bubbles.highlightBubble(bubble);
            } else {
              chat.setMessageId({
                lastMsgId: message.mid,
                lastMsgPeerId: message.peerId
              });
            }
          } else {
            chat.input.initMessageEditing(message.mid);
          }
        });
      }

      return;
    } else if(key === 'ArrowDown') {
      return;
    }

    if(
      chat?.input?.messageInput &&
      target !== chat.input.messageInput &&
      !isTargetAnInput &&
      !IS_TOUCH_SUPPORTED &&
      (!mediaSizes.isMobile || isChatTab()) &&
      !chat.selection.isSelecting &&
      !chat.input.recording &&
      chat.input.messageInput.isContentEditable
    ) {
      chat.input.passEventToInput(e);
    }
  };
}
