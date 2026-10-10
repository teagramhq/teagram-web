import WebSocket from 'ws';
import {MAX_PRE_AUTH_ABRIDGED_PACKET_BYTES} from '@lib/mtproto/transports/abridged';

export type NodeWebSocketMetrics = {
  upgradeStatus?: number,
  requestCount: number,
  close1000Sent: boolean,
  peerClosed: boolean,
  malformed: boolean
};

type RuntimeConnectionListener = (data?: ArrayBuffer) => void;
type HarnessWebSocket = {
  readyState: number,
  on: (type: string, listener: (...args: any[]) => void) => void,
  send: (data: Buffer) => void,
  close: (code?: number) => void,
  terminate: () => void
};
type HarnessWebSocketConstructor = new(
  endpoint: string,
  subprotocol: string,
  options: {headers: Record<string, string>, maxPayload: number, perMessageDeflate: boolean}
) => HarnessWebSocket;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

export class NodeWebSocketConnection {
  private socket: HarnessWebSocket;
  private listeners = new Map<string, Set<RuntimeConnectionListener>>();
  private localClose = false;
  private closeDispatched = false;
  private initSent = false;

  constructor(
    _dcId: number,
    endpoint: string,
    _logSuffix: string,
    origin: string,
    subprotocol: string,
    private metrics: NodeWebSocketMetrics,
    socketConstructor: HarnessWebSocketConstructor = WebSocket as unknown as HarnessWebSocketConstructor
  ) {
    this.socket = new socketConstructor(endpoint, subprotocol, {
      headers: {Origin: origin},
      maxPayload: MAX_PRE_AUTH_ABRIDGED_PACKET_BYTES,
      perMessageDeflate: false
    });
    const requestClose = this.socket.close.bind(this.socket);
    this.socket.close = (code?: number) => {
      if(code === 1009 && this.socket.readyState === WS_OPEN) {
        this.metrics.malformed = true;
        this.localClose = true;
        try {
          requestClose(1000);
          this.metrics.close1000Sent = true;
        } catch(error) {
          this.metrics.close1000Sent = false;
          throw error;
        }
        return;
      }

      requestClose(code);
    };

    this.socket.on('upgrade', (response) => {
      this.metrics.upgradeStatus = response.statusCode;
    });
    this.socket.on('open', () => {
      this.metrics.upgradeStatus = 101;
      this.dispatch('open');
    });
    this.socket.on('unexpected-response', (_request, response) => {
      this.metrics.upgradeStatus = response.statusCode;
      response.resume();
      this.socket.terminate();
      this.dispatchClose();
    });
    this.socket.on('message', (data, isBinary) => {
      if(!isBinary) {
        this.metrics.malformed = true;
        this.close();
        this.dispatchClose();
        return;
      }

      const byteLength = Array.isArray(data)
        ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
        : data.byteLength;
      if(byteLength > MAX_PRE_AUTH_ABRIDGED_PACKET_BYTES) {
        this.metrics.malformed = true;
        this.close();
        this.dispatchClose();
        return;
      }

      const bytes = Array.isArray(data) ? Buffer.concat(data, byteLength) : Buffer.from(data as Buffer);
      const copy = new Uint8Array(byteLength);
      copy.set(bytes);
      this.dispatch('message', copy.buffer);
    });
    this.socket.on('close', () => {
      if(!this.localClose && !this.metrics.malformed) this.metrics.peerClosed = true;
      this.dispatchClose();
    });
    this.socket.on('error', error => {
      const code = error && typeof error === 'object' ? (error as {code?: unknown}).code : undefined;
      if(code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') this.metrics.malformed = true;
      if(this.metrics.upgradeStatus === undefined) this.metrics.upgradeStatus = 0;
      if(this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
    });
  }

  public addEventListener(type: string, listener: RuntimeConnectionListener) {
    const listeners = this.listeners.get(type) ?? new Set<RuntimeConnectionListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: RuntimeConnectionListener) {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);
    if(!listeners?.size) this.listeners.delete(type);
  }

  public send(data: Uint8Array) {
    if(this.socket.readyState !== WS_OPEN) {
      throw new Error('connection_not_open');
    }

    if(this.initSent) this.metrics.requestCount++;
    else this.initSent = true;
    this.socket.send(Buffer.from(data));
  }

  public close() {
    if(this.socket.readyState === WS_OPEN) {
      try {
        this.localClose = true;
        this.socket.close(1000);
        this.metrics.close1000Sent = true;
      } catch{
        this.metrics.close1000Sent = false;
      }
    } else if(this.socket.readyState === WS_CONNECTING) {
      this.localClose = true;
      this.socket.terminate();
    }
  }

  private dispatch(type: string, data?: ArrayBuffer) {
    for(const listener of this.listeners.get(type) ?? []) listener(data);
  }

  private dispatchClose() {
    if(this.closeDispatched) return;
    this.closeDispatched = true;
    this.dispatch('close');
  }
}
