import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import CryptoWorker from '@lib/crypto/cryptoMessagePort';
import {Authorizer} from '@lib/mtproto/authorizer';
import {TimeManager} from '@lib/mtproto/timeManager';
import {TLSerialization} from '@lib/mtproto/tl_utils';
import withoutUint8ArrayConcat from '@/tests/helpers/withoutUint8ArrayConcat';

type AuthorizerTestSurface = {
  decryptServerDhDataAnswer: (auth: any, encryptedAnswer: Uint8Array) => Promise<void>,
  sendSetClientDhParams: (auth: any) => Promise<unknown>,
  verifyDhParams: (g: number, dhPrime: Uint8Array, gA: Uint8Array) => boolean
};

afterEach(() => vi.restoreAllMocks());

describe('authorizer DH helpers without Uint8Array.concat', () => {
  it('decrypts and validates the server DH answer without the extension', async() => {
    const nonce = new Uint8Array(16).fill(0x01);
    const serverNonce = new Uint8Array(16).fill(0x02);
    const newNonce = new Uint8Array(32).fill(0x03);
    const inner = new TLSerialization({mtproto: true});
    inner.storeObject({
      _: 'server_DH_inner_data',
      nonce,
      server_nonce: serverNonce,
      g: 3,
      dh_prime: new Uint8Array([0x10, 0x11]),
      g_a: new Uint8Array([0x12]),
      server_time: 1
    }, 'Server_DH_inner_data');
    const innerBytes = inner.getBytes(true);
    const innerHash = new Uint8Array(createHash('sha1').update(innerBytes).digest());
    const decryptedAnswer = new Uint8Array(20 + innerBytes.length);
    decryptedAnswer.set(innerHash);
    decryptedAnswer.set(innerBytes, 20);
    const sha1Results = [
      new Uint8Array(20).fill(0x11),
      new Uint8Array(20).fill(0x22),
      new Uint8Array(20).fill(0x33),
      new Uint8Array(20).fill(0x44),
      innerHash
    ];
    vi.spyOn(CryptoWorker, 'invokeCrypto').mockImplementation((async(method: string) => {
      if(method === 'aes-decrypt') return decryptedAnswer as any;
      return sha1Results.shift() as any;
    }) as any);

    const authorizer = new Authorizer({timeManager: new TimeManager(), dcConfigurator: {} as never});
    const internals = authorizer as unknown as AuthorizerTestSurface;
    vi.spyOn(internals, 'verifyDhParams').mockReturnValue(true);
    const auth: any = {nonce, serverNonce, newNonce};

    await withoutUint8ArrayConcat(() => internals.decryptServerDhDataAnswer(auth, new Uint8Array([0x99])));

    expect(auth.tmpAesKey.slice(0, 20)).toEqual(new Uint8Array(20).fill(0x11));
    expect(auth.tmpAesKey.slice(20)).toEqual(new Uint8Array(12).fill(0x22));
    expect(auth.tmpAesIv.slice(0, 8)).toEqual(new Uint8Array(8).fill(0x33));
    expect(auth.tmpAesIv.slice(8, 28)).toEqual(new Uint8Array(20).fill(0x44));
    expect(auth.tmpAesIv.slice(28)).toEqual(newNonce.slice(0, 4));
    expect(auth.g).toBe(3);
    expect(auth.gA).toEqual(new Uint8Array([0x12]));
  });

  it.each([
    {branch: 'dh_gen_ok', nonceMarkers: [1], branchHashBytes: [0x44], rejects: false},
    {branch: 'dh_gen_retry', nonceMarkers: [2, 3], branchHashBytes: [0x44, 0x55], rejects: true},
    {branch: 'dh_gen_fail', nonceMarkers: [3], branchHashBytes: [0x44], rejects: true}
  ])('handles $branch client DH responses without the extension', async({branch, nonceMarkers, branchHashBytes, rejects}) => {
    const nonce = new Uint8Array(16).fill(0x01);
    const serverNonce = new Uint8Array(16).fill(0x22);
    const newNonce = new Uint8Array(32).fill(0x11);
    const authKey = new Uint8Array(256).fill(0x55);
    const sha1Results = branchHashBytes.flatMap((hashByte) => [
      new Uint8Array(20).fill(0x22),
      new Uint8Array(20).fill(0x33),
      new Uint8Array(20).fill(hashByte)
    ]);
    const makeResponse = (type: string, marker: number, hashByte: number) => ({
      _: type,
      nonce,
      server_nonce: serverNonce,
      [`new_nonce_hash${marker}`]: new Uint8Array(16).fill(hashByte)
    });
    const responses = branch === 'dh_gen_retry' ? [
      makeResponse('dh_gen_retry', 2, 0x44),
      makeResponse('dh_gen_fail', 3, 0x55)
    ] : branch === 'dh_gen_fail' ? [
      makeResponse('dh_gen_fail', 3, 0x44)
    ] : [
      makeResponse('dh_gen_ok', 1, 0x44)
    ];
    let modPowCall = 0;
    const crypto = vi.spyOn(CryptoWorker, 'invokeCrypto').mockImplementation((async(method: string) => {
      if(method === 'mod-pow') return (modPowCall++ % 2 === 0 ? new Uint8Array([0x33]) : authKey) as any;
      if(method === 'sha1') return sha1Results.shift() as any;
      if(method === 'aes-encrypt') return new Uint8Array([0x66]) as any;
      throw new Error(`Unexpected crypto method: ${method}`);
    }) as any);

    const authorizer = new Authorizer({timeManager: new TimeManager(), dcConfigurator: {} as never});
    const internals = authorizer as unknown as AuthorizerTestSurface;
    const sendPlainRequest = vi.spyOn(authorizer as any, 'sendPlainRequest').mockImplementation(async() => {
      const response = responses.shift();
      if(!response) throw new Error('Missing synthetic DH response');
      return {fetchObject: () => response};
    });
    const auth: any = {
      dcId: 1,
      nonce,
      serverNonce,
      newNonce,
      g: 3,
      retry: 0,
      tmpAesKey: new Uint8Array(32).fill(0x77),
      tmpAesIv: new Uint8Array(32).fill(0x88),
      dhPrime: new Uint8Array([0x99]),
      gA: new Uint8Array([0xaa])
    };

    const request = withoutUint8ArrayConcat(() => internals.sendSetClientDhParams(auth));
    if(rejects) {
      await expect(request).rejects.toThrow('Set_client_DH_params_answer fail');
    } else {
      await expect(request).resolves.toBe(auth);
    }

    const sha1Inputs = crypto.mock.calls.filter(([method]) => method === 'sha1').map(([, bytes]) => bytes as Uint8Array);
    expect(sendPlainRequest).toHaveBeenCalledTimes(nonceMarkers.length);
    nonceMarkers.forEach((marker, attempt) => {
      expect(sha1Inputs[attempt * 3 + 2]).toEqual(new Uint8Array([...newNonce, marker, ...new Uint8Array(8).fill(0x33)]));
    });
    const encryptedData = crypto.mock.calls.find(([method]) => method === 'aes-encrypt')?.[1] as Uint8Array;
    expect(encryptedData.slice(0, 20)).toEqual(new Uint8Array(20).fill(0x22));
    if(branch === 'dh_gen_ok') {
      expect(auth.serverSalt).toEqual(new Uint8Array(8).fill(0x33));
      expect(auth.authKey).toBeDefined();
    }
  });
});
