import {Codec} from '@lib/mtproto/transports/codec';

// Includes the frame header and matches the existing WebSocket message bound.
export const MAX_ABRIDGED_PACKET_BYTES = 16 * 1024 * 1024 + 64;
// Before an auth key exists, only key-exchange replies are valid and fit well below this limit.
export const MAX_PRE_AUTH_ABRIDGED_PACKET_BYTES = 64 * 1024;

type AbridgedPacketHeader = {
  headerLength: number,
  packetLength: number
};

const readAbridgedPacketHeader = (header: Uint8Array, maxPacketBytes: number): AbridgedPacketHeader | undefined => {
  if(!header.length) return undefined;

  const first = header[0];
  if(first === 0 || first > 0x7f) {
    throw new Error('invalid abridged packet length');
  }

  const headerLength = first === 0x7f ? 4 : 1;
  if(header.length < headerLength) return undefined;

  const lengthUnits = headerLength === 1 ? first : header[1] | (header[2] << 8) | (header[3] << 16);
  if(!lengthUnits || (headerLength === 4 && lengthUnits < 127)) {
    throw new Error('invalid abridged packet length');
  }

  const packetLength = headerLength + lengthUnits * 4;
  if(packetLength > maxPacketBytes) {
    throw new Error('abridged packet exceeds receive limit');
  }

  return {headerLength, packetLength};
};

export class AbridgedPacketStream {
  private frame = new Uint8Array(0);
  private frameBytes = 0;
  private frameLength = 0;
  private frameHeaderLength = 0;
  private frameMaxBytes = 0;

  public get bufferedBytes() {
    return this.frameBytes;
  }

  public reset() {
    this.frame = new Uint8Array(0);
    this.frameBytes = 0;
    this.frameLength = 0;
    this.frameHeaderLength = 0;
    this.frameMaxBytes = 0;
  }

  public async consume(data: Uint8Array, maxPacketBytes: number, onPacket: (packet: Uint8Array) => void | Promise<void>) {
    let offset = 0;

    while(offset < data.length) {
      if(!this.frameBytes) {
        const first = data[offset];
        const headerLength = first === 0x7f ? 4 : 1;
        const available = data.length - offset;

        if(available < headerLength) {
          this.frame = new Uint8Array(headerLength);
          this.frame.set(data.subarray(offset));
          this.frameBytes = available;
          this.frameHeaderLength = headerLength;
          this.frameMaxBytes = maxPacketBytes;
          return;
        }

        const header = readAbridgedPacketHeader(data.subarray(offset, offset + headerLength), maxPacketBytes);
        if(available >= header.packetLength) {
          const packet = data.subarray(offset + header.headerLength, offset + header.packetLength);
          offset += header.packetLength;
          const result = onPacket(packet);
          if(result && typeof(result as Promise<void>).then === 'function') await result;
          continue;
        }

        this.frame = new Uint8Array(available);
        this.frame.set(data.subarray(offset));
        this.frameBytes = available;
        this.frameLength = header.packetLength;
        this.frameHeaderLength = header.headerLength;
        this.frameMaxBytes = maxPacketBytes;
        return;
      }

      if(!this.frameLength) {
        const take = Math.min(this.frameHeaderLength - this.frameBytes, data.length - offset);
        this.appendFrame(data.subarray(offset, offset + take), this.frameHeaderLength);
        this.frameBytes += take;
        offset += take;

        if(this.frameBytes < this.frameHeaderLength) return;

        const header = readAbridgedPacketHeader(this.frame.subarray(0, this.frameHeaderLength), this.frameMaxBytes);
        this.frameLength = header.packetLength;
      }

      const take = Math.min(this.frameLength - this.frameBytes, data.length - offset);
      this.appendFrame(data.subarray(offset, offset + take), this.frameLength);
      this.frameBytes += take;
      offset += take;

      if(this.frameBytes < this.frameLength) return;

      const packet = this.frame.subarray(this.frameHeaderLength, this.frameLength);
      this.reset();
      const result = onPacket(packet);
      if(result && typeof(result as Promise<void>).then === 'function') await result;
    }
  }

  private appendFrame(bytes: Uint8Array, maxBytes: number) {
    const required = this.frameBytes + bytes.length;
    if(this.frame.length < required) {
      let capacity = Math.max(4, this.frame.length);
      while(capacity < required) {
        capacity = Math.min(maxBytes, capacity * 2);
      }

      const frame = new Uint8Array(capacity);
      frame.set(this.frame.subarray(0, this.frameBytes));
      this.frame = frame;
    }

    this.frame.set(bytes, this.frameBytes);
  }
}

class AbridgedPacketCodec implements Codec {
  public tag = 0xef;
  public obfuscateTag = new Uint8Array([this.tag, this.tag, this.tag, this.tag]);

  public encodePacket(data: Uint8Array) {
    const len = data.byteLength >> 2;
    let header: Uint8Array;
    if(len < 127) {
      header = new Uint8Array([len]);
    } else { // Length: payload length, divided by four, and encoded as 3 length bytes (little endian)
      // header = new Uint8Array([0x7f, ...addPadding(bytesFromHex(len.toString(16)).reverse(), 3, true)/* .reverse() */]);
      header = new Uint8Array([0x7f, len & 0xFF, (len >> 8) & 0xFF, (len >> 16) & 0xFF]);
      // console.log('got nobody cause im braindead', header, len);
    }

    return header.concat(data);
    // return new Uint8Array([...header, ...data]);
  }

  public readPacket(data: Uint8Array) {
    const headerLength = data[0] === 0x7f ? 4 : 1;
    const header = readAbridgedPacketHeader(data.subarray(0, headerLength), MAX_ABRIDGED_PACKET_BYTES);
    if(!header || data.length < header.packetLength) return new Uint8Array(0);

    return data.slice(header.headerLength, header.packetLength);
  }
}

export default new AbridgedPacketCodec();
