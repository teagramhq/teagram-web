import {afterEach, describe, expect, it, vi} from 'vitest';
import CryptoWorker from '@lib/crypto/cryptoMessagePort';
import {Authorizer} from '@lib/mtproto/authorizer';
import {TimeManager} from '@lib/mtproto/timeManager';

vi.mock('@helpers/random', async(importOriginal) => {
  const actual: any = await importOriginal();
  return {...actual, randomBytes: vi.fn((length: number) => new Uint8Array(length).fill(7))};
});

type AuthorizerTestSurface = {
  sendSetClientDhParams: (auth: Record<string, unknown>) => Promise<unknown>,
  sendPlainRequest: (transport: unknown, request: Uint8Array) => Promise<{fetchObject: () => unknown}>
};

describe('authorizer DH key exchange errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects with the original error when mod-pow fails computing the auth key', async() => {
    const nonce = new Uint8Array(16).fill(1);
    const serverNonce = new Uint8Array(16).fill(2);
    const modPowError = new Error('sentinel mod-pow failure');
    const authorizer = new Authorizer({
      timeManager: new TimeManager(),
      dcConfigurator: {} as never
    });
    const internals = authorizer as unknown as AuthorizerTestSurface;

    vi.spyOn(CryptoWorker, 'invokeCrypto')
    .mockResolvedValueOnce(new Uint8Array([3]))
    .mockResolvedValueOnce(new Uint8Array(20))
    .mockResolvedValueOnce(new Uint8Array(16))
    .mockRejectedValueOnce(modPowError);
    vi.spyOn(internals, 'sendPlainRequest').mockResolvedValue({
      fetchObject: () => ({_: 'dh_gen_ok', nonce, server_nonce: serverNonce})
    });

    const auth = {
      dcId: 1,
      nonce,
      serverNonce,
      temp: false,
      media: false,
      retry: 0,
      g: 3,
      gA: new Uint8Array([4]),
      dhPrime: new Uint8Array([5]),
      tmpAesKey: new Uint8Array(32),
      tmpAesIv: new Uint8Array(32)
    };

    await expect(internals.sendSetClientDhParams(auth)).rejects.toBe(modPowError);
  });
});
