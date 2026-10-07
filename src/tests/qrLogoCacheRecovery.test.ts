import {afterEach, expect, it, vi} from 'vitest';

const LOGO_COLOR = '#qr-logo-cache-recovery';
const LOGO_SVG = '<svg style="fill:#000;"></svg>';

class QRCodeStylingStub {
  public options: {image: string};
  public _drawingPromise = Promise.resolve();

  public constructor(options: {image: string}) {
    this.options = options;
  }

  public append(host: HTMLElement) {
    host.appendChild(document.createElement('canvas'));
  }
}

function makeOptions(color = LOGO_COLOR) {
  return {
    data: 'tg://login?token=fixture-token',
    size: 128,
    host: document.createElement('div'),
    background: '#fff',
    foreground: '#000',
    logoColor: color,
    QRCodeStylingCtor: QRCodeStylingStub
  };
}

function makeSuccessfulResponse() {
  return {ok: true, text: vi.fn().mockResolvedValue(LOGO_SVG)};
}

function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve: resolve!, reject: reject!};
}

async function importFreshPainter() {
  vi.resetModules();
  return import('@helpers/qrCode/paintQrCode');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('recovers after a rejected logo fetch and keeps the successful result cached', async() => {
  const successfulResponse = makeSuccessfulResponse();
  const fetchMock = vi.fn()
  .mockRejectedValueOnce(new Error('private fetch detail'))
  .mockResolvedValueOnce(successfulResponse);
  vi.stubGlobal('fetch', fetchMock);
  const {paintQrCode} = await importFreshPainter();

  await expect(paintQrCode(makeOptions())).rejects.toThrow('private fetch detail');
  const recovered = await paintQrCode(makeOptions());
  const reused = await paintQrCode(makeOptions());

  expect(recovered.canvas).toBeInstanceOf(HTMLCanvasElement);
  expect(reused.canvas).toBeInstanceOf(HTMLCanvasElement);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(successfulResponse.text).toHaveBeenCalledOnce();
  expect(recovered.qrCode.options.image).toBe(reused.qrCode.options.image);
});

it('treats non-OK logo responses as failures and recovers on the next paint', async() => {
  const failedResponse = {ok: false, text: vi.fn().mockResolvedValue('private error body')};
  const successfulResponse = makeSuccessfulResponse();
  const fetchMock = vi.fn()
  .mockResolvedValueOnce(failedResponse)
  .mockResolvedValueOnce(successfulResponse);
  vi.stubGlobal('fetch', fetchMock);
  const {paintQrCode} = await importFreshPainter();

  await expect(paintQrCode(makeOptions())).rejects.toThrow('QR logo unavailable');
  expect(failedResponse.text).not.toHaveBeenCalled();
  expect(successfulResponse.text).not.toHaveBeenCalled();
  const recovered = await paintQrCode(makeOptions());

  expect(recovered.canvas).toBeInstanceOf(HTMLCanvasElement);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(successfulResponse.text).toHaveBeenCalledOnce();
});

it('shares concurrent failures and recovers with one cached successful fetch', async() => {
  const pendingResponse = deferred<ReturnType<typeof makeSuccessfulResponse>>();
  const successfulResponse = makeSuccessfulResponse();
  const fetchMock = vi.fn()
  .mockReturnValueOnce(pendingResponse.promise)
  .mockResolvedValueOnce(successfulResponse);
  vi.stubGlobal('fetch', fetchMock);
  const {paintQrCode} = await importFreshPainter();

  const firstPaint = paintQrCode(makeOptions());
  const secondPaint = paintQrCode(makeOptions());
  expect(fetchMock).toHaveBeenCalledOnce();
  pendingResponse.reject(new Error('private concurrent fetch detail'));
  await expect(Promise.all([firstPaint, secondPaint])).rejects.toThrow('private concurrent fetch detail');

  const firstRetry = paintQrCode(makeOptions());
  const secondRetry = paintQrCode(makeOptions());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [first, second] = await Promise.all([firstRetry, secondRetry]);
  const reused = await paintQrCode(makeOptions());

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(successfulResponse.text).toHaveBeenCalledOnce();
  expect(first.canvas).toBeInstanceOf(HTMLCanvasElement);
  expect(second.canvas).toBeInstanceOf(HTMLCanvasElement);
  expect(reused.qrCode.options.image).toBe(first.qrCode.options.image);
});

it('does not let an old rejection evict a newer logo entry', async() => {
  const pendingResponse = deferred<ReturnType<typeof makeSuccessfulResponse>>();
  const fetchMock = vi.fn(() => pendingResponse.promise);
  vi.stubGlobal('fetch', fetchMock);
  let logoUrlCache: Map<string, Promise<string>>;
  const originalSet = Map.prototype.set;
  vi.spyOn(Map.prototype, 'set').mockImplementation(function(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    const result = originalSet.call(this, key as never, value as never);
    if(key === LOGO_COLOR && value instanceof Promise) logoUrlCache = this as unknown as Map<string, Promise<string>>;
    return result;
  } as any);
  const {paintQrCode} = await importFreshPainter();

  const stalePaint = paintQrCode(makeOptions());
  const newerEntry = Promise.resolve('newer-logo-data-url');
  logoUrlCache!.set(LOGO_COLOR, newerEntry);
  pendingResponse.reject(new Error('private stale fetch detail'));
  await expect(stalePaint).rejects.toThrow('private stale fetch detail');

  expect(logoUrlCache!.get(LOGO_COLOR)).toBe(newerEntry);
  const nextPaint = await paintQrCode(makeOptions());
  expect(nextPaint.qrCode.options.image).toBe('newer-logo-data-url');
  expect(fetchMock).toHaveBeenCalledOnce();
});
