import {afterEach, describe, expect, it, vi} from 'vitest';
import {IntermediatePacketCodec} from '@lib/mtproto/transports/intermediate';
import paddedIntermediatePacketCodec from '@lib/mtproto/transports/padded';
import withoutUint8ArrayConcat from '@/tests/helpers/withoutUint8ArrayConcat';

afterEach(() => vi.restoreAllMocks());

describe('MTProto intermediate packet codecs without Uint8Array.concat', () => {
  it('encodes and reads intermediate packets with the original framing', async() => {
    const codec = new IntermediatePacketCodec();
    const packet = new Uint8Array([1, 2, 3, 4]);

    await withoutUint8ArrayConcat(async() => {
      const encoded = codec.encodePacket(packet);

      expect(Array.from(encoded)).toEqual([4, 0, 0, 0, 1, 2, 3, 4]);
      expect(codec.readPacket(encoded)).toEqual(packet);
    });
  });

  it('encodes and reads padded packets without changing the payload', async() => {
    const packet = new Uint8Array([1, 2, 3, 4]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await withoutUint8ArrayConcat(async() => {
      const encoded = paddedIntermediatePacketCodec.encodePacket(packet);
      const length = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(0, true);

      expect(length).toBe(encoded.byteLength - 4);
      expect(encoded.slice(4, 8)).toEqual(packet);
      expect(paddedIntermediatePacketCodec.readPacket(encoded)).toEqual(packet);
    });
  });
});
