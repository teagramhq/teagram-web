import {FullMid, makeFullMid, splitFullMid} from '@appManagers/utils/messages/fullMid';


export function getCurrentMessageFullMid(fullMid: FullMid, messageMid: number, changedMids: ReadonlyMap<number, number>): FullMid {
  const changedMid = changedMids.get(messageMid);
  if(changedMid === undefined) return fullMid;

  return makeFullMid(splitFullMid(fullMid).peerId, changedMid);
}
