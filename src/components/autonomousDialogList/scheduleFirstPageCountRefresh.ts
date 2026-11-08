// This refresh only corrects the total count after the first visible page. Keep it out of the
// chat-open and history-scroll interaction window, where it competes with rendering.
const FIRST_PAGE_COUNT_REFRESH_DELAY_MS = 15_000;

export function scheduleFirstPageCountRefresh(callback: () => void) {
  return self.setTimeout(callback, FIRST_PAGE_COUNT_REFRESH_DELAY_MS);
}
