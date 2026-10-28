// A share target payload waits in the service worker under a one-time token. The landing
// tab keeps the token for the session, so the page that finally proves its server can
// claim the payload even after the server check reloads it.
export const SHARE_TOKEN_PARAM = 'tgshare';
const SHARE_TOKEN_KEY = 'teagram.share-token.v1';
const SHARE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function takeShareTokenFromUrl() {
  const url = new URL(location.href);
  const token = url.searchParams.get(SHARE_TOKEN_PARAM);
  if(token === null) return;

  url.searchParams.delete(SHARE_TOKEN_PARAM);
  history.replaceState(history.state, '', url.href);
  if(!SHARE_TOKEN_PATTERN.test(token)) return;
  try {
    window.sessionStorage.setItem(SHARE_TOKEN_KEY, token);
  } catch{}
}

export function getPendingShareToken() {
  try {
    return window.sessionStorage.getItem(SHARE_TOKEN_KEY) || undefined;
  } catch{
    return undefined;
  }
}

export function clearPendingShareToken() {
  try {
    window.sessionStorage.removeItem(SHARE_TOKEN_KEY);
  } catch{}
}
