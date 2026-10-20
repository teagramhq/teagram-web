import type {MtprotoTarget} from '@config/mtprotoTarget';
import {getMtprotoTarget} from '@config/mtprotoTarget';

export function assertPrivateMtprotoWebSocketEndpoint(target: MtprotoTarget, endpoint: string) {
  const activeTarget = getMtprotoTarget();
  if(target.mode !== activeTarget.mode || target.mode === 'private' && activeTarget.mode === 'private' &&
    (target.endpoint !== activeTarget.endpoint || target.fingerprint !== activeTarget.fingerprint)) {
    throw new Error('[MT] private MTProto target disagrees with the active server');
  }
  if(target.mode === 'private' && endpoint !== target.endpoint) {
    throw new Error('[MT] private MTProto endpoint is not allowed');
  }
}
