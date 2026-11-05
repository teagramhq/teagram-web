import {FullMid, makeFullMid, splitFullMid} from '@appManagers/utils/messages/fullMid';


export function getCurrentMessageFullMid(fullMid: FullMid, messageMid: number, changedMids: ReadonlyMap<number, number>): FullMid {
  const changedMid = changedMids.get(messageMid);
  if(changedMid === undefined) return fullMid;

  return makeFullMid(splitFullMid(fullMid).peerId, changedMid);
}

// * A reverse (older) history page is rendered, grouped, sliced and mounted as one batch. For a
// * full page that is one task of 100+ ms. Rendering it in small sequential chunks, with a task
// * boundary between them, keeps every task short and the prepend progressive.
export const HISTORY_RENDER_CHUNK_SIZE = 8;

export async function renderHistoryInChunks<T>(
  items: readonly T[],
  chunkSize: number,
  render: (chunk: T[]) => Promise<unknown>,
  yieldToBrowser: () => Promise<unknown>,
  isCurrent: () => boolean = () => true
) {
  for(let i = 0; i < items.length; i += chunkSize) {
    if(i > 0) {
      await yieldToBrowser();
      if(!isCurrent()) return;
    }

    await render(items.slice(i, i + chunkSize));
  }
}
