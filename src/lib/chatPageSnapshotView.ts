import type {ChatPageRow} from '@lib/chatPageSnapshot';
import getPreviewURLFromBytes from '@helpers/bytes/getPreviewURLFromBytes';
import Icon from '@components/icon';
import {watchChatPageSnapshotInvalidations} from '@lib/chatPageSnapshot';
import {listenForGuestCredentialInvalidation} from '@lib/guestCredentialBroadcast';
import {getRuntimeServerId} from '@config/serverContext';
import type {ActiveAccountNumber} from '@lib/accounts/types';

let snapshotElement: HTMLElement;
let livePageArrived = false;
let stopWatching: () => void;

export function watchChatPageSnapshot(accountNumber: ActiveAccountNumber, guest: boolean) {
  const stopSnapshot = watchChatPageSnapshotInvalidations(accountNumber, replaceChatPageSnapshot);
  const stopGuest = guest ? listenForGuestCredentialInvalidation(getRuntimeServerId(), replaceChatPageSnapshot, true) : undefined;
  stopWatching = () => { stopSnapshot(); stopGuest?.(); };
}

function element(tag: string, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if(text !== undefined) node.textContent = text;
  return node;
}

export function paintChatPageSnapshot(rows: ChatPageRow[] | undefined) {
  if(livePageArrived || !rows?.length) return;
  const container = document.getElementById('chatlist-container');
  const page = document.getElementById('page-chats');
  if(!container || !page) return;

  const scrollable = snapshotElement = element('div', 'chat-page-snapshot scrollable scrollable-y chatlist-parts');
  const top = element('div', 'chatlist-top');
  const list = element('ul', 'chatlist');
  for(const row of rows) {
    const item = element('div', 'row row-clickable row-with-padding no-wrap chatlist-chat chatlist-chat-bigger row-big');
    if(row.muted) item.classList.add('is-muted');
    const titleRow = element('div', 'row-row row-title-row dialog-title');
    const title = element('div', 'row-title no-wrap user-title', row.title);
    title.dir = 'auto';
    if(row.muted) title.append(Icon('nosound_filled', 'dialog-muted-icon'));
    const details = element('div', 'row-title-right row-title-right-secondary dialog-title-details');
    const time = element('span', 'message-time', row.date ? new Date(row.date * 1000).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) : '');
    details.append(time);
    titleRow.append(title, details);
    const subtitle = element('div', 'row-row row-subtitle-row dialog-subtitle has-multiple-badges');
    const preview = element('div', 'row-subtitle no-wrap', row.preview);
    preview.dir = 'auto';
    subtitle.append(preview);
    if(row.unread || row.markedUnread) {
      subtitle.append(element('div', 'dialog-subtitle-badge badge badge-22 dialog-subtitle-badge-unread is-visible forwards', row.unread ? String(row.unread) : ''));
    } else if(row.pinned) {
      const badge = element('div', 'dialog-subtitle-badge badge badge-icon badge-22 dialog-subtitle-badge-pinned is-visible forwards');
      badge.append(Icon('chatspinned'));
      subtitle.append(badge);
    }
    const avatar = element('div', 'avatar avatar-like avatar-gradient dialog-avatar row-media row-media-bigger', row.title.trim().slice(0, 1));
    if(row.avatar && 'stripped_thumb' in row.avatar && row.avatar.stripped_thumb?.length) {
      const image = document.createElement('img');
      image.className = 'avatar-photo avatar-photo-thumbnail';
      image.src = getPreviewURLFromBytes(row.avatar.stripped_thumb);
      avatar.replaceChildren(image);
    }
    item.append(titleRow, subtitle, avatar);
    list.append(item);
  }
  top.append(list);
  scrollable.append(top);
  container.append(scrollable);
  page.style.display = '';
  document.body.classList.add('is-left-column-shown');
}

export function replaceChatPageSnapshot() {
  livePageArrived = true;
  stopWatching?.();
  stopWatching = undefined;
  snapshotElement?.remove();
  snapshotElement = undefined;
}
