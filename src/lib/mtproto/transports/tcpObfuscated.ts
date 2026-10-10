import Modes from '@config/modes';
import {logger, LogTypes} from '@lib/logger';
import MTPNetworker from '@lib/mtproto/networker';
import Obfuscation from '@lib/mtproto/transports/obfuscation';
import MTTransport, {MTConnection, MTConnectionConstructable} from '@lib/mtproto/transports/transport';
import {
  AbridgedPacketStream,
  MAX_ABRIDGED_PACKET_BYTES,
  MAX_PRE_AUTH_ABRIDGED_PACKET_BYTES
} from '@lib/mtproto/transports/abridged';
// import intermediatePacketCodec from '@lib/mtproto/transports/intermediate';
import abridgedPacketCodec from '@lib/mtproto/transports/abridged';
// import paddedIntermediatePacketCodec from '@lib/mtproto/transports/padded';
import {ConnectionStatus} from '@lib/mtproto/connectionStatus';
import transportController from '@lib/mtproto/transports/controller';
// import networkStats from '@lib/mtproto/networkStats';
import ctx from '@environment/ctx';
import {getMtprotoTarget} from '@config/mtprotoTarget';

type QueuedReceive = {
  data: Uint8Array,
  time: number
};

type ReceiveState = {
  generation: number,
  connection: MTConnection,
  obfuscation: Obfuscation,
  packetStream: AbridgedPacketStream,
  queue: QueuedReceive[],
  queuedBytes: number,
  processingBytes: number,
  processing: boolean,
  releasingPending: boolean,
  active: boolean
};

export default class TcpObfuscated implements MTTransport {
  private codec = abridgedPacketCodec;
  private receiveState: ReceiveState;
  private connectionGeneration = 0;
  public networker: MTPNetworker;

  private pending: Array<Partial<{
    resolve: any,
    reject: any,
    body: Uint8Array,
    encoded?: Uint8Array,
    bodySent: boolean
  }>> = [];

  private debug = Modes.debug && false/* true */;
  private log: ReturnType<typeof logger>;
  public connected = false;
  private lastCloseTime: number;
  public connection: MTConnection;

  private autoReconnect = true;
  private reconnectTimeout: number;

  // private debugPayloads: MTPNetworker['debugRequests'] = [];

  constructor(
    private Connection: MTConnectionConstructable,
    private dcId: number,
    private url: string,
    private logSuffix: string,
    private retryTimeout: number
  ) {
    const target = getMtprotoTarget();
    if(target.mode === 'private' && url !== target.endpoint) {
      throw new Error('[MT] private MTProto target endpoint is immutable');
    }

    let logTypes = LogTypes.Error | LogTypes.Log;
    if(this.debug) logTypes |= LogTypes.Debug;
    this.log = logger(`TCP-${dcId}` + logSuffix, logTypes);
    this.log('constructor');

    this.connect();
  }

  private onOpen = async() => {
    const state = this.receiveState;
    if(!state || !this.isCurrent(state)) return;

    this.connected = true;

    if(import.meta.env.VITE_MTPROTO_AUTO && Modes.multipleTransports) {
      transportController.setTransportOpened('websocket');
    }

    try {
      const initPayload = await state.obfuscation.init(this.codec);
      if(!this.isCurrent(state)) return;

      state.connection.send(initPayload);

      if(this.networker) {
        this.pending.length = 0; // ! clear queue and reformat messages to container, because if sending simultaneously 10+ messages, connection will die
        this.networker.onTransportOpen();
      }

      setTimeout(() => {
        if(this.isCurrent(state)) this.releasePending();
      }, 0);
    } catch{
      this.failReceive(state);
    }
  };

  private onMessage = (buffer: ArrayBuffer) => {
    // networkStats.addReceived(this.dcId, buffer.byteLength);
    const state = this.receiveState;
    if(!state || !this.isCurrent(state) || !this.connected || !buffer.byteLength) return;

    const data = new Uint8Array(buffer);
    const bufferedBytes = state.queuedBytes + state.processingBytes + state.packetStream.bufferedBytes;
    if(bufferedBytes + data.byteLength > MAX_ABRIDGED_PACKET_BYTES) {
      this.failReceive(state);
      return;
    }

    state.queue.push({data, time: Date.now()});
    state.queuedBytes += data.byteLength;
    this.processReceiveQueue(state);
  };

  private onClose = () => {
    let needTimeout: number, retryAt: number;
    if(this.autoReconnect) {
      const time = Date.now();
      const diff = time - this.lastCloseTime;
      needTimeout = !isNaN(diff) && diff < this.retryTimeout ? this.retryTimeout - diff : 0;
      retryAt = time + needTimeout;
    }

    const networker = this.networker;
    this.clear();

    if(networker) {
      networker.setConnectionStatus(ConnectionStatus.Closed, retryAt);
    }

    if(this.autoReconnect) {
      this.log('will try to reconnect after timeout:', needTimeout / 1000);
      this.reconnectTimeout = ctx.setTimeout(this.reconnect, needTimeout);
    } else {
      this.log('reconnect isn\'t needed');
    }
  };

  public clear() {
    if(import.meta.env.VITE_MTPROTO_AUTO && Modes.multipleTransports) {
      if(this.connected) {
        transportController.setTransportClosed('websocket');
      }
    }

    this.connected = false;

    if(this.connection) {
      this.connection.removeEventListener('open', this.onOpen);
      this.connection.removeEventListener('close', this.onClose);
      this.connection.removeEventListener('message', this.onMessage);
      this.connection = undefined;
    }

    const state = this.receiveState;
    this.receiveState = undefined;
    if(state) {
      state.active = false;
      state.queue.length = 0;
      state.queuedBytes = 0;
      state.processingBytes = 0;
      state.packetStream.reset();
      state.obfuscation.destroy();
    }

    if(this.networker) {
      this.pending.length = 0;
    } else {
      this.rejectPending(new Error('[MT] connection closed'));
    }
  }

  /**
   * invoke only when closed
   */
  public reconnect = () => {
    if(this.reconnectTimeout !== undefined) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    if(this.connection) {
      return;
    }

    this.log('trying to reconnect...');
    this.lastCloseTime = Date.now();

    if(this.networker) {
      this.networker.setConnectionStatus(ConnectionStatus.Connecting);
    }

    this.connect();
  }

  public forceReconnect() {
    this.close();
    this.reconnect();
  }

  public destroy() {
    this.setAutoReconnect(false);
    this.close();

    this.rejectPending(new Error('[MT] transport destroyed'));
  }

  public close() {
    const connection = this.connection;
    if(connection) {
      this.clear();
      connection.close();
    }
  }

  /**
   * Will connect if enable and disconnected \
   * Will reset reconnection timeout if disable
   */
  public setAutoReconnect(enable: boolean) {
    this.autoReconnect = enable;

    if(!enable) {
      if(this.reconnectTimeout !== undefined) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }
    } else if(!this.connection && this.reconnectTimeout === undefined) {
      this.reconnect();
    }
  }

  private connect() {
    if(this.connection) {
      this.close();
    }

    this.connection = new this.Connection(this.dcId, this.url, this.logSuffix);
    this.receiveState = {
      generation: ++this.connectionGeneration,
      connection: this.connection,
      obfuscation: new Obfuscation(),
      packetStream: new AbridgedPacketStream(),
      queue: [],
      queuedBytes: 0,
      processingBytes: 0,
      processing: false,
      releasingPending: false,
      active: true
    };
    this.connection.addEventListener('open', this.onOpen);
    this.connection.addEventListener('close', this.onClose);
    this.connection.addEventListener('message', this.onMessage);
  }

  public changeUrl(url: string) {
    const target = getMtprotoTarget();
    if(target.mode === 'private' && url !== target.endpoint) {
      throw new Error('[MT] private MTProto target endpoint is immutable');
    }

    if(this.url === url) {
      return;
    }

    this.url = url;
    this.forceReconnect();
  }

  private encodeBody(body: Uint8Array, state: ReceiveState) {
    const toEncode = this.codec.encodePacket(body);

    // this.log('send before obf:', /* body.hex, nonce.hex, */ toEncode.hex);
    const encoded = state.obfuscation.encode(toEncode);
    // this.log('send after obf:', enc.hex);

    return encoded;
  }

  public send(body: Uint8Array) {
    this.debug && this.log.debug('-> body length to pending:', body.length);

    const encoded: typeof body = /* this.connected ? this.encodeBody(body) :  */undefined;

    // return;

    if(this.networker) {
      this.pending.push({body, encoded});
      this.releasePending();
    } else {
      const promise = new Promise<typeof body>((resolve, reject) => {
        this.pending.push({resolve, reject, body, encoded});
      });

      this.releasePending();

      return promise;
    }
  }

  private async releasePending() {
    const state = this.receiveState;
    if(!this.connected || !state || !this.isCurrent(state) || state.releasingPending) {
      // this.connect();
      return;
    }

    state.releasingPending = true;

    /* if(!tt) {
      this.releasePendingDebounced();
      return;
    } */

    // this.log('-> messages to send:', this.pending.length);
    let length = this.pending.length;
    let sent = false;
    // for(let i = length - 1; i >= 0; --i) {
    for(let i = 0; i < length; ++i) {
      const pending = this.pending[i];
      if(!pending) {
        break;
      }

      const {body, bodySent} = pending;
      if(body && !bodySent) {
        // this.debugPayloads.push({before: body.slice(), after: enc});

        this.debug && this.log.debug('-> body length to send:', body.length);

        // if(!encoded) {
        //   encoded = pending.encoded = this.encodeBody(body);
        // }

        const encoded = pending.encoded ??= await this.encodeBody(body, state);
        if(!this.connected || !this.isCurrent(state)) {
          break;
        }

        // networkStats.addSent(this.dcId, encoded.byteLength);
        state.connection.send(encoded);

        if(!pending.resolve) { // remove if no response needed
          this.pending.splice(i--, 1);
          length--;
        } else {
          pending.bodySent = true;
        }

        sent = true;
        // delete pending.body;
      }
    }

    state.releasingPending = false;

    if(this.isCurrent(state) && this.pending.length && sent) {
      this.releasePending();
    }
  }

  private async processReceiveQueue(state: ReceiveState) {
    if(state.processing) return;

    state.processing = true;
    try {
      while(this.isCurrent(state) && state.queue.length) {
        const queued = state.queue.shift();
        state.queuedBytes -= queued.data.byteLength;
        state.processingBytes = queued.data.byteLength;

        const data = await state.obfuscation.decode(queued.data);
        if(!this.isCurrent(state)) return;

        const maxPacketBytes = this.networker ? MAX_ABRIDGED_PACKET_BYTES : MAX_PRE_AUTH_ABRIDGED_PACKET_BYTES;
        await state.packetStream.consume(data, maxPacketBytes, async packet => {
          if(!this.isCurrent(state)) return;

          if(this.networker) {
            await this.networker.onTransportData(packet, queued.time);
            return;
          }

          const pending = this.pending.shift();
          if(!pending) {
            this.debug && this.log.debug('no pending for response packet');
            return;
          }

          pending.resolve(packet);
        });

        if(!this.isCurrent(state)) return;
        state.processingBytes = 0;
      }
    } catch{
      this.failReceive(state);
    } finally {
      state.processingBytes = 0;
      state.processing = false;
      if(this.isCurrent(state) && state.queue.length) this.processReceiveQueue(state);
    }
  }

  private isCurrent(state: ReceiveState) {
    return state.active && this.receiveState === state && this.connection === state.connection && this.connectionGeneration === state.generation;
  }

  private failReceive(state: ReceiveState) {
    if(!this.isCurrent(state)) return;

    const connection = state.connection;
    this.onClose();
    connection.close();
  }

  private rejectPending(error: Error) {
    for(const pending of this.pending.splice(0)) {
      pending.reject?.(error);
    }
  }
}
