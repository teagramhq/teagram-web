import type {ChatPageRow} from '@lib/chatPageSnapshot';
import getPreviewURLFromBytes from '@helpers/bytes/getPreviewURLFromBytes';
import I18n from '@lib/langPack';
import getAbbreviation from '@lib/richTextProcessor/getAbbreviation';
import Icon from '@components/icon';
import {watchChatPageSnapshotInvalidations} from '@lib/chatPageSnapshot';
import {listenForGuestCredentialInvalidation} from '@lib/guestCredentialBroadcast';
import {getRuntimeServerId} from '@config/serverContext';
import type {ActiveAccountNumber} from '@lib/accounts/types';

let snapshotElement: HTMLElement;
let livePageArrived = false;
let stopWatching: () => void;

function getWeekNumber(date: Date) {
  const weekDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = weekDate.getUTCDay() || 7;
  weekDate.setUTCDate(weekDate.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(weekDate.getUTCFullYear(), 0, 1));
  return Math.ceil((((weekDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function formatSnapshotDate(time: Date) {
  const today = new Date();
  const now = today.getTime() / 1000 | 0;
  const timestamp = time.getTime() / 1000 | 0;
  const options: Intl.DateTimeFormatOptions = {};
  if((now - timestamp) < 86400 && today.getDate() === time.getDate()) {
    options.hour = options.minute = '2-digit';
  } else if(today.getFullYear() !== time.getFullYear()) {
    options.year = options.day = 'numeric';
    options.month = '2-digit';
  } else if((now - timestamp) < (86400 * 7) && getWeekNumber(today) === getWeekNumber(time)) {
    options.weekday = 'short';
  } else {
    options.month = 'short';
    options.day = 'numeric';
  }

  return new I18n.IntlDateElement({date: time, options}).element;
}

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
  if(!container) {
    console.error('Could not paint chat page snapshot: missing #chatlist-container');
    return;
  }
  if(!page) {
    console.error('Could not paint chat page snapshot: missing #page-chats');
    return;
  }

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
    const time = element('span', 'message-time');
    if(row.date) time.append(formatSnapshotDate(new Date(row.date * 1000)));
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
    const avatar = element('div', 'avatar avatar-like avatar-gradient dialog-avatar row-media row-media-bigger');
    if(row.avatarColor) avatar.dataset.color = row.avatarColor;
    avatar.textContent = getAbbreviation(row.title).text;
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
