import {beforeEach, expect, it, vi} from 'vitest';
import '@lib/polyfill';
let paintChatPageSnapshot: typeof import('@lib/chatPageSnapshotView')['paintChatPageSnapshot'];
let replaceChatPageSnapshot: typeof import('@lib/chatPageSnapshotView')['replaceChatPageSnapshot'];
let watchChatPageSnapshot: typeof import('@lib/chatPageSnapshotView')['watchChatPageSnapshot'];

const rows = [
  {peerId: 42 as PeerId, title: 'Alice', preview: 'Hello', date: 1, unread: 2, markedUnread: false, muted: true, pinned: false},
  {peerId: 43 as PeerId, title: 'Bob', preview: 'Photo', date: 2, unread: 0, markedUnread: false, muted: false, pinned: true}
];

beforeEach(async() => {
  vi.resetModules();
  ({paintChatPageSnapshot, replaceChatPageSnapshot, watchChatPageSnapshot} = await import('@lib/chatPageSnapshotView'));
  document.body.innerHTML = '<div id="page-chats" style="display:none"><div id="chatlist-container"><div id="folders-container"></div></div></div>';
});

it.each(['passcode', 'logout or reset', 'other tab', 'other tab passcode', 'guest wipe', 'other tab guest wipe'])(
  'removes painted rows on %s invalidation', async(reason) => {
    watchChatPageSnapshot(1, true);
    paintChatPageSnapshot(rows);
    const snapshots = await import('@lib/chatPageSnapshot');
    if(reason === 'passcode') snapshots.blockSnapshotReads();
    if(reason === 'logout or reset') snapshots.setChatPageAccountGuard('default', 1);
    if(reason === 'other tab') window.dispatchEvent(new StorageEvent('storage', {key: 'teagram.chat-page-snapshot-account:default:1'}));
    if(reason === 'other tab passcode') window.dispatchEvent(new StorageEvent('storage', {key: 'chat-page-snapshot-guard'}));
    if(reason === 'guest wipe') (await import('@lib/guestCredentialBroadcast')).notifyGuestCredentialInvalidation('default');
    if(reason === 'other tab guest wipe') window.dispatchEvent(new StorageEvent('storage', {key: 'guest-credential-lifecycle-clear.v1'}));
    expect(document.querySelector('.chat-page-snapshot')).toBeNull();
    paintChatPageSnapshot(rows);
    expect(document.querySelector('.chat-page-snapshot')).toBeNull();
  }
);

it('keeps the page when a different account is invalidated', async() => {
  watchChatPageSnapshot(1, false);
  paintChatPageSnapshot(rows);
  (await import('@lib/chatPageSnapshot')).setChatPageAccountGuard('default', 2);
  expect(document.querySelectorAll('.chatlist-chat')).toHaveLength(2);
  replaceChatPageSnapshot();
});

it('does not paint if invalidated while guest verification is pending', async() => {
  watchChatPageSnapshot(1, true);
  (await import('@lib/guestCredentialBroadcast')).notifyGuestCredentialInvalidation('default');
  paintChatPageSnapshot(rows);
  expect(document.querySelector('.chat-page-snapshot')).toBeNull();
});

it('does not paint a late snapshot after the live page arrived', () => {
  replaceChatPageSnapshot();
  paintChatPageSnapshot(rows);
  expect(document.querySelector('.chat-page-snapshot')).toBeNull();
});

it('paints the saved page and permits a harmless click', () => {
  paintChatPageSnapshot(rows);
  expect(document.querySelectorAll('.chatlist-chat')).toHaveLength(2);
  expect(document.getElementById('chatlist-container').textContent).toContain('Alice');
  expect(document.getElementById('chatlist-container').textContent).toContain('Hello');
  expect(document.querySelector('.chatlist-chat .dialog-muted-icon')).not.toBeNull();
  expect(() => (document.querySelector('.chatlist-chat') as HTMLElement).click()).not.toThrow();
});

it('does not paint an absent or mismatched page', () => {
  paintChatPageSnapshot(undefined);
  expect(document.querySelectorAll('.chatlist-chat')).toHaveLength(0);
  expect(document.getElementById('page-chats').style.display).toBe('none');
});

it('shows a saved avatar thumbnail when available', () => {
  paintChatPageSnapshot([{...rows[0], avatar: {_: 'userProfilePhoto', pFlags: {}, photo_id: '1', dc_id: 2, stripped_thumb: new Uint8Array([1, 1, 1, 0])}}]);
  expect(document.querySelector<HTMLImageElement>('.dialog-avatar img')?.src).toMatch(/^data:image\/jpeg;base64,/);
});

it('replaces the whole saved page when live rows arrive', () => {
  paintChatPageSnapshot(rows);
  const live = document.createElement('div');
  live.className = 'chatlist-chat';
  live.textContent = 'Live';
  document.getElementById('folders-container').append(live);
  replaceChatPageSnapshot();
  expect(Array.from(document.querySelectorAll('.chatlist-chat'), (row) => row.textContent)).toEqual(['Live']);
});
