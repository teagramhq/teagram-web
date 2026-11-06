import SuperMessagePort from '@lib/superMessagePort';
import {reconcilePeer, usePeers} from '@stores/peers';
import {installWorkerMessageAttribution} from './workerMessageAttribution';

(globalThis as any).__workerReplay = {SuperMessagePort, reconcilePeer, usePeers, installWorkerMessageAttribution};
