import cancelEvent from '@helpers/dom/cancelEvent';

export type ChatPreviewAnchor = HTMLElement | {x: number, y: number} | {
  x: number, y: number, left: number, right: number, top: number, bottom: number
};

export type ChatPreviewOptions = {
  peerId: PeerId,
  threadId?: number,
  monoforumThreadId?: number,
  lastMsgId?: number,
  anchor?: ChatPreviewAnchor
};

/**
 * Build a preview anchor from a dialog row. Anchors to the LEFT COLUMN's right edge
 * (instead of the row's own right edge) so the 8px gap from the sidebar is constant
 * regardless of the row's internal padding. Shared by Shift+Click and the context-menu
 * "Preview" entry — both want the popup pinned the same way.
 */
export function chatPreviewAnchorFromDialogRow(li: HTMLElement): ChatPreviewAnchor {
  const rect = li.getBoundingClientRect();
  const columnEl = li.closest<HTMLElement>('#column-left, .sidebar-left');
  const columnRight = columnEl?.getBoundingClientRect().right ?? rect.right;
  return {
    x: columnRight,
    y: rect.top + rect.height / 2,
    left: rect.left,
    right: columnRight,
    top: rect.top,
    bottom: rect.bottom
  };
}

export function openChatPreviewFromDialogRow(
  event: MouseEvent,
  li: HTMLElement,
  options: Omit<ChatPreviewOptions, 'anchor'>
) {
  const anchor = chatPreviewAnchorFromDialogRow(li);
  cancelEvent(event);

  return import('@components/popups/chatPreview').then(({default: showChatPreviewPopup}) => {
    return showChatPreviewPopup({...options, anchor});
  });
}
