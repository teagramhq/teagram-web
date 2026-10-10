import {describe, expect, it, vi} from 'vitest';
import {MAX_PRE_AUTH_ABRIDGED_PACKET_BYTES} from '@lib/mtproto/transports/abridged';
import {NodeWebSocketConnection} from './l1PrekeyNodeWebSocket';

type FakeMessageListener = (...args: any[]) => void;

class FakeWebSocket {
  public readyState = 1;
  public options?: {maxPayload: number};
  public closeCode?: number;
  private listeners = new Map<string, FakeMessageListener[]>();

  constructor(_endpoint: string, _subprotocol: string, options: {maxPayload: number}) {
    this.options = options;
  }

  public on(type: string, listener: FakeMessageListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public emit(type: string, ...args: unknown[]) {
    for(const listener of this.listeners.get(type) ?? []) listener(...args);
  }

  public send(_data: Buffer) {}

  public close(code?: number) {
    this.closeCode = code;
    this.readyState = 2;
  }

  public terminate() {
    this.readyState = 3;
  }
}

describe('Node WebSocket pre-auth payload bound', () => {
  it('sets the WebSocket limit and drops oversized messages before copying or dispatching', () => {
    const metrics = {requestCount: 0, close1000Sent: false, peerClosed: false, malformed: false};
    let socket: FakeWebSocket | undefined;
    class CapturedWebSocket extends FakeWebSocket {
      constructor(endpoint: string, subprotocol: string, options: {maxPayload: number}) {
        super(endpoint, subprotocol, options);
        socket = this;
      }
    }
    const connection = new NodeWebSocketConnection(
      1,
      'wss://diagnostic.example.test/apiws',
      '-test',
      'https://web.example.test',
      'binary',
      metrics,
      CapturedWebSocket
    );
    let dispatchCount = 0;
    connection.addEventListener('message', () => dispatchCount++);
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      socket!.emit('message', [
        Buffer.alloc(MAX_PRE_AUTH_ABRIDGED_PACKET_BYTES),
        Buffer.alloc(1)
      ], true);

      expect(socket!.options?.maxPayload).toBe(MAX_PRE_AUTH_ABRIDGED_PACKET_BYTES);
      expect(socket!.closeCode).toBe(1000);
      expect(metrics.malformed).toBe(true);
      expect(metrics.close1000Sent).toBe(true);
      expect(dispatchCount).toBe(0);
      expect(concat).not.toHaveBeenCalled();
    } finally {
      concat.mockRestore();
    }
  });

  it('classifies a WebSocket max-payload rejection as malformed', () => {
    const metrics = {requestCount: 0, close1000Sent: false, peerClosed: false, malformed: false};
    let socket: FakeWebSocket | undefined;
    class CapturedWebSocket extends FakeWebSocket {
      constructor(endpoint: string, subprotocol: string, options: {maxPayload: number}) {
        super(endpoint, subprotocol, options);
        socket = this;
      }
    }
    new NodeWebSocketConnection(
      1,
      'wss://diagnostic.example.test/apiws',
      '-test',
      'https://web.example.test',
      'binary',
      metrics,
      CapturedWebSocket
    );

    socket!.emit('error', {code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'});
    socket!.emit('close', 1009, Buffer.alloc(0));

    expect(metrics.malformed).toBe(true);
    expect(metrics.peerClosed).toBe(false);
    expect(metrics.close1000Sent).toBe(false);
  });
});
