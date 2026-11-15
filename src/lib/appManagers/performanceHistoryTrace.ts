import type {PerformanceRpcTrace} from '@appManagers/performanceTrace';

export function trackHistoryPerformanceRpc<P extends Promise<unknown>>(trace: PerformanceRpcTrace | undefined, request: P, params: unknown): P {
  const handle = trace?.start('messages.getHistory');
  if(handle) {
    const peer = (params as {peer?: {_: string, user_id?: string | number, chat_id?: string | number, channel_id?: string | number}})?.peer;
    const kind = peer?._ === 'inputPeerUser' || peer?._ === 'inputPeerUserFromMessage' ? 'user' :
      peer?._ === 'inputPeerChat' ? 'chat' :
        peer?._ === 'inputPeerChannel' || peer?._ === 'inputPeerChannelFromMessage' ? 'channel' : undefined;
    const id = kind === 'user' ? peer?.user_id : kind === 'chat' ? peer?.chat_id : kind === 'channel' ? peer?.channel_id : undefined;
    if(kind && id !== undefined && /^[1-9]\d*$/.test(String(id))) {
      Object.assign(handle.trace, {historyPeer: `${kind}:${id}`});
    }
  }
  return trace?.track(handle, request) ?? request;
}
