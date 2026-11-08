import {describe, expect, it} from 'vitest';
import CTR from '@lib/crypto/utils/aesCTR';

describe('AES-CTR', () => {
  it('preserves fragmented updates when Uint8Array.concat is unavailable', async() => {
    const cryptoKey = await self.crypto.subtle.importKey(
      'raw',
      new Uint8Array(16),
      {name: 'AES-CTR'},
      false,
      ['encrypt']
    );
    const createCtr = () => new CTR('encrypt', cryptoKey, new Uint8Array(16));
    const updateChunk = (ctr: CTR, data: Uint8Array) => {
      return (ctr as unknown as {_update(data: Uint8Array): Promise<Uint8Array>})._update(data);
    };
    const data = new Uint8Array(Array.from({length: 16}, (_, index) => index));
    const expected = await updateChunk(createCtr(), data);
    const concatDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'concat');

    Reflect.deleteProperty(Uint8Array.prototype, 'concat');
    try {
      const ctr = createCtr();
      const first = await updateChunk(ctr, data.slice(0, 1));
      const second = await updateChunk(ctr, data.slice(1));

      expect(new Uint8Array([...first, ...second])).toEqual(expected);
    } finally {
      if(concatDescriptor) Object.defineProperty(Uint8Array.prototype, 'concat', concatDescriptor);
    }
  });
});
