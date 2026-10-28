import {describe, expect, it} from 'vitest';
import abridgedPacketCodec from '@lib/mtproto/transports/abridged';

describe('abridged packet codec', () => {
  it('encodes a short packet without Uint8Array.concat', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);

    expect(abridgedPacketCodec.encodePacket(payload)).toEqual(new Uint8Array([1, 1, 2, 3, 4]));
  });

  it('encodes an extended packet without Uint8Array.concat', () => {
    const payload = new Uint8Array(127 * 4).fill(0x2a);
    const expected = new Uint8Array(4 + payload.length);
    expected.set([0x7f, 127, 0, 0]);
    expected.set(payload, 4);

    expect(abridgedPacketCodec.encodePacket(payload)).toEqual(expected);
  });
});
