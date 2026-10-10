import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import EventListenerBase from '@helpers/eventListenerBase';
import abridgedPacketCodec from '@lib/mtproto/transports/abridged';
import Obfuscation from '@lib/mtproto/transports/obfuscation';
import TcpObfuscated from '@lib/mtproto/transports/tcpObfuscated';
import deferred from './helpers/deferred';

type ConnectionEvents = {
  open: () => void,
  message: (buffer: ArrayBuffer) => void,
  close: () => void
};

class FakeConnection extends EventListenerBase<ConnectionEvents> {
  public static instances: FakeConnection[] = [];
  public sent: Uint8Array[] = [];
  public closeCount = 0;

  constructor(
    public dcId: number,
    public url: string,
    public logSuffix: string
  ) {
    super();
    FakeConnection.instances.push(this);
  }

  public send(data: Uint8Array) {
    this.sent.push(data.slice());
  }

  public async open() {
    await Promise.all(this.dispatchResultableEvent('open'));
  }

  public message(data: Uint8Array) {
    this.dispatchEvent('message', data.slice().buffer);
  }

  public serverClose() {
    this.dispatchEvent('close');
  }

  public close() {
    this.closeCount++;
    this.dispatchEvent('close');
  }
}

const transports: TcpObfuscated[] = [];

const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for(const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const packet = (payload: Uint8Array) => {
  const units = payload.byteLength / 4;
  const header = units < 127 ?
    new Uint8Array([units]) :
    new Uint8Array([0x7f, units & 0xff, (units >> 8) & 0xff, (units >> 16) & 0xff]);
  return concat(header, payload);
};

const flushMicrotasks = async() => {
  for(let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
};

const createTransport = async(networker?: Record<string, any>) => {
  const transport = new TcpObfuscated(FakeConnection as any, 1, 'wss://synthetic.example.test/apiws', '', 3000);
  transports.push(transport);
  transport.setAutoReconnect(false);
  if(networker) transport.networker = networker as any;
  const connection = FakeConnection.instances[FakeConnection.instances.length - 1];
  await connection.open();
  return {transport, connection};
};

const createRequest = (transport: TcpObfuscated) => {
  let outcome: {status: 'resolved', value: Uint8Array} | {status: 'rejected', error: unknown} | undefined;
  const promise = transport.send(new Uint8Array([0, 0, 0, 0])) as Promise<Uint8Array>;
  promise.then(
    value => outcome = {status: 'resolved', value},
    error => outcome = {status: 'rejected', error}
  );
  return {promise, get outcome() {return outcome;}};
};

describe('TcpObfuscated abridged receive path', () => {
  beforeEach(() => {
    FakeConnection.instances = [];
    vi.spyOn(abridgedPacketCodec, 'encodePacket').mockImplementation(data => data);
    vi.spyOn(Obfuscation.prototype, 'init').mockResolvedValue(new Uint8Array(64));
    vi.spyOn(Obfuscation.prototype, 'encode').mockImplementation(async data => data);
    vi.spyOn(Obfuscation.prototype, 'decode').mockImplementation(async data => data);
    vi.spyOn(Obfuscation.prototype, 'destroy').mockImplementation(() => {});
  });

  afterEach(() => {
    for(const transport of transports.splice(0)) transport.destroy();
    vi.restoreAllMocks();
  });

  it('extracts only the declared payload from a coalesced buffer', () => {
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([5, 6, 7, 8]);

    expect(abridgedPacketCodec.readPacket(concat(packet(first), packet(second)))).toEqual(first);
  });

  it('waits for a split packet body and resolves the original payload once', async() => {
    const {transport, connection} = await createTransport();
    const payload = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const request = createRequest(transport);

    connection.message(packet(payload).subarray(0, 1));
    await flushMicrotasks();
    expect(request.outcome).toBeUndefined();

    connection.message(packet(payload).subarray(1));
    await expect(request.promise).resolves.toEqual(payload);
    await flushMicrotasks();
    expect(request.outcome).toEqual({status: 'resolved', value: payload});
  });

  it.each([1, 2, 3])('reassembles an extended header split after byte %s', async(splitAt) => {
    const {transport, connection} = await createTransport();
    const payload = Uint8Array.from({length: 508}, (_, index) => index & 0xff);
    const framed = packet(payload);
    const request = createRequest(transport);

    connection.message(framed.subarray(0, splitAt));
    await flushMicrotasks();
    expect(request.outcome).toBeUndefined();

    connection.message(framed.subarray(splitAt));
    await expect(request.promise).resolves.toEqual(payload);
  });

  it('delivers byte-by-byte packets and coalesced packets as exact payloads in request order', async() => {
    const {transport, connection} = await createTransport();
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([5, 6, 7, 8]);
    const firstRequest = createRequest(transport);
    const secondRequest = createRequest(transport);

    const firstFrame = packet(first);
    for(const byte of firstFrame) connection.message(new Uint8Array([byte]));
    connection.message(concat(packet(second), packet(first)));

    await expect(firstRequest.promise).resolves.toEqual(first);
    await expect(secondRequest.promise).resolves.toEqual(second);
  });

  it('delivers a complete packet before waiting for an incomplete trailing packet', async() => {
    const {transport, connection} = await createTransport();
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([5, 6, 7, 8]);
    const firstRequest = createRequest(transport);
    const secondRequest = createRequest(transport);
    const secondFrame = packet(second);

    connection.message(concat(packet(first), secondFrame.subarray(0, 3)));
    await expect(firstRequest.promise).resolves.toEqual(first);
    await flushMicrotasks();
    expect(secondRequest.outcome).toBeUndefined();

    connection.message(secondFrame.subarray(3));
    await expect(secondRequest.promise).resolves.toEqual(second);
  });

  it('ignores empty messages and closes on a zero-length packet without resolving a request', async() => {
    const {transport, connection} = await createTransport();
    const request = createRequest(transport);

    connection.message(new Uint8Array(0));
    await flushMicrotasks();
    expect(request.outcome).toBeUndefined();

    connection.message(new Uint8Array([0]));
    await flushMicrotasks();
    expect(connection.closeCount).toBeGreaterThan(0);
    expect(request.outcome?.status).toBe('rejected');
  });

  it.each([
    ['extended zero length', new Uint8Array([0x7f, 0, 0, 0])],
    ['reserved length marker', new Uint8Array([0x80])]
  ])('closes on %s framing and rejects the pending request', async(_name, header) => {
    const {transport, connection} = await createTransport();
    const request = createRequest(transport);

    connection.message(header);
    await flushMicrotasks();

    expect(connection.closeCount).toBeGreaterThan(0);
    expect(request.outcome?.status).toBe('rejected');
  });

  it('rejects an over-cap pre-authentication packet from its header alone', async() => {
    const {transport, connection} = await createTransport();
    const request = createRequest(transport);

    connection.message(new Uint8Array([0x7f, 0x00, 0x40, 0x00]));
    await flushMicrotasks();

    expect(connection.closeCount).toBeGreaterThan(0);
    expect(request.outcome?.status).toBe('rejected');
  });

  it('rejects authenticated packets above the 16 MiB plus 64-byte cap from the header', async() => {
    const networker = {
      onTransportOpen: vi.fn(),
      onTransportData: vi.fn(async() => {}),
      setConnectionStatus: vi.fn()
    };
    const {connection} = await createTransport(networker);
    const overCapUnits = 0x400011;

    connection.message(new Uint8Array([0x7f, overCapUnits & 0xff, (overCapUnits >> 8) & 0xff, (overCapUnits >> 16) & 0xff]));
    await flushMicrotasks();

    expect(connection.closeCount).toBeGreaterThan(0);
    expect(networker.onTransportData).not.toHaveBeenCalled();
  });

  it('discards partial packets and rejects pending requests on disconnect', async() => {
    const {transport, connection} = await createTransport();
    const request = createRequest(transport);

    connection.message(new Uint8Array([1]));
    await flushMicrotasks();
    connection.serverClose();
    await flushMicrotasks();

    expect(request.outcome?.status).toBe('rejected');

    transport.reconnect();
    const replacement = FakeConnection.instances[1];
    await replacement.open();
    const replacementRequest = createRequest(transport);
    replacement.message(new Uint8Array([0x11, 0x22, 0x33, 0x44]));
    await flushMicrotasks();
    expect(replacementRequest.outcome).toBeUndefined();
  });

  it('delivers every coalesced authenticated packet once with exact boundaries', async() => {
    const received: Uint8Array[] = [];
    const networker = {
      onTransportOpen: vi.fn(),
      onTransportData: vi.fn(async(data: Uint8Array) => {received.push(data.slice());}),
      setConnectionStatus: vi.fn()
    };
    const decode = vi.spyOn(Obfuscation.prototype, 'decode').mockImplementation(async data => data);
    const {connection} = await createTransport(networker);
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([5, 6, 7, 8]);

    connection.message(concat(packet(first), packet(second)));
    await flushMicrotasks();

    expect(received).toEqual([first, second]);
    expect(networker.onTransportData).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('serializes deobfuscation and authenticated packet delivery', async() => {
    const firstDecode = deferred<Uint8Array>();
    const received: Uint8Array[] = [];
    const networker = {
      onTransportOpen: vi.fn(),
      onTransportData: vi.fn(async(data: Uint8Array) => {received.push(data.slice());}),
      setConnectionStatus: vi.fn()
    };
    const decode = vi.spyOn(Obfuscation.prototype, 'decode')
    .mockImplementationOnce(() => firstDecode.promise)
    .mockImplementation(async data => data);
    const {connection} = await createTransport(networker);
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([5, 6, 7, 8]);

    connection.message(packet(first));
    connection.message(packet(second));
    await flushMicrotasks();
    expect(decode).toHaveBeenCalledTimes(1);

    firstDecode.resolve(packet(first));
    await flushMicrotasks();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode.mock.calls.map(([data]) => Array.from(data))).toEqual([
      Array.from(packet(first)),
      Array.from(packet(second))
    ]);
    expect(received).toEqual([first, second]);
  });

  it('drops a delayed decode from a replaced connection', async() => {
    const oldDecode = deferred<Uint8Array>();
    const received: Uint8Array[] = [];
    const networker = {
      onTransportOpen: vi.fn(),
      onTransportData: vi.fn(async(data: Uint8Array) => {received.push(data.slice());}),
      setConnectionStatus: vi.fn()
    };
    vi.spyOn(Obfuscation.prototype, 'decode')
    .mockImplementationOnce(() => oldDecode.promise)
    .mockImplementation(async data => data);
    const {transport, connection} = await createTransport(networker);
    const oldPayload = new Uint8Array([1, 2, 3, 4]);
    connection.message(packet(oldPayload));
    await flushMicrotasks();

    transport.forceReconnect();
    const replacement = FakeConnection.instances[1];
    await replacement.open();
    oldDecode.resolve(packet(oldPayload));
    await flushMicrotasks();

    expect(received).toEqual([]);

    const replacementPayload = new Uint8Array([5, 6, 7, 8]);
    replacement.message(packet(replacementPayload));
    await flushMicrotasks();
    expect(received).toEqual([replacementPayload]);
  });
});
