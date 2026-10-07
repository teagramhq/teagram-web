import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';
import SignQRCard from '@/pages/cards/SignQRCard';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<{handler: (...args: any[]) => void, once: boolean}>>();

  return {
    invokeApi: vi.fn(),
    setBaseDcId: vi.fn(),
    setUser: vi.fn(),
    getServerTimeOffset: vi.fn(),
    pushToState: vi.fn(),
    getUserIds: vi.fn(),
    navigate: vi.fn(),
    toIm: vi.fn(),
    paintQrCode: vi.fn(),
    addEventListener: vi.fn((name: string, handler: (...args: any[]) => void, options?: {once?: boolean}) => {
      const entries = listeners.get(name) || [];
      entries.push({handler, once: !!options?.once});
      listeners.set(name, entries);
    }),
    removeEventListener: vi.fn((name: string, handler: (...args: any[]) => void) => {
      listeners.set(name, (listeners.get(name) || []).filter((entry) => entry.handler !== handler));
    }),
    dispatchEvent(name: string) {
      const entries = listeners.get(name) || [];
      listeners.set(name, entries.filter((entry) => !entry.once));
      entries.forEach((entry) => entry.handler());
    },
    clearListeners() {
      listeners.clear();
    },
    privateTarget: false
  };
});

vi.mock('@/pages/authFlow', () => ({
  useAuthFlow: () => ({
    managers: {
      apiManager: {
        invokeApi: mocks.invokeApi,
        setBaseDcId: mocks.setBaseDcId,
        setUser: mocks.setUser
      },
      appStateManager: {pushToState: mocks.pushToState},
      timeManager: {getServerTimeOffset: mocks.getServerTimeOffset}
    },
    navigate: mocks.navigate,
    toIm: mocks.toIm
  })
}));

vi.mock('@config/mtprotoTarget', () => ({
  isPrivateMtprotoTarget: () => mocks.privateTarget
}));

vi.mock('@lib/accounts/accountController', () => ({
  default: {getUserIds: mocks.getUserIds}
}));

vi.mock('@lib/accounts/getCurrentAccount', () => ({
  getCurrentAccount: () => 1
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    addEventListener: mocks.addEventListener,
    removeEventListener: mocks.removeEventListener
  }
}));

vi.mock('@lib/langPack', () => ({
  i18n: (key: string) => ({
    'Login.QR.Title': 'Log in by QR Code',
    'Login.QR.Subtitle': 'Scan with Telegram app on your phone',
    'Login.QR.Help1': 'Open Telegram on your phone',
    'Login.QR.Help2': 'Go to Settings > Devices > Add Device',
    'Login.QR.Help3': 'Point your phone at this screen to confirm login',
    'Login.QR.Cancel': 'Log in by phone number >',
    'Login.QR.Unsupported.Title': 'QR code sign-in unavailable',
    'Login.QR.Unsupported.Text': 'This server doesn\'t support QR code sign-in.',
    'Login.QR.Error.Title': 'Connection problem',
    'Login.QR.Error.Text': 'The QR code couldn\'t be loaded. Check your connection and try again.',
    'Login.QR.Retry': 'Try again',
    'Login.QR.Username': 'Sign in with username'
  } as Record<string, string>)[key] || key
}));

vi.mock('@components/buttonTsx', () => ({
  default: (props: any) => (
    <button
      ref={props.ref}
      type="button"
      class={props.class}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.text ? ({
        'Login.QR.Cancel': mocks.privateTarget ? 'Sign in with username' : 'Log in by phone number >',
        'Login.QR.Unsupported.Title': 'QR code sign-in unavailable',
        'Login.QR.Retry': 'Try again',
        'Login.QR.Username': 'Sign in with username'
      } as Record<string, string>)[props.text] || props.text : props.children}
    </button>
  )
}));

vi.mock('@components/iconTsx', () => ({
  IconTsx: (props: any) => <span class={props.class} aria-hidden={props['aria-hidden']}>{props.icon}</span>
}));

vi.mock('@components/putPreloader', () => ({
  putPreloader: (host: HTMLElement) => {
    const element = document.createElement('div');
    element.className = 'preloader';
    host.appendChild(element);
    return element;
  }
}));

vi.mock('@components/languageChangeButton', () => ({
  default: () => <button type="button">Language</button>
}));

vi.mock('@components/passkeyLoginButton', () => ({
  default: () => <button type="button">Passkey</button>
}));

vi.mock('@helpers/bytes/bytesToBase64', () => ({default: () => 'c2VjcmV0LXRva2Vu'}));
vi.mock('@helpers/fixBase64String', () => ({default: (value: string) => value}));
vi.mock('@helpers/qrCode/paintQrCode', () => ({paintQrCode: mocks.paintQrCode}));
vi.mock('@helpers/schedulers/pause', () => ({default: vi.fn(() => Promise.resolve())}));
vi.mock('@/pages/AuthCard', () => ({
  default: (props: any) => <div class={props.class}>{props.header}{props.children}</div>
}));
vi.mock('@/pages/authFlow.module.scss', () => ({
  default: {pageSignQR: 'page-sign-qr', qrDescription: 'qr-description', qrDescriptionItem: 'qr-description-item', qrDescriptionMarker: 'qr-description-marker', qrContainer: 'qr-container', qrCanvas: 'qr-canvas'}
}));
vi.mock('@components/mediaHeader.module.scss', () => ({
  default: {container: 'media-header-container', marginBottom: 'media-header-margin-bottom', sticker: 'media-header-sticker', lottie: 'media-header-lottie', title: 'media-header-title', subtitle: 'media-header-subtitle', secondary: 'media-header-secondary'}
}));
vi.mock('@helpers/string/classNames', () => ({
  default: (...values: Array<string | undefined | false>) => values.filter(Boolean).join(' ')
}));
vi.mock('@config/app', () => ({default: {id: 1, hash: 'test'}}));
vi.mock('@helpers/bytes/bytesCmp', () => ({default: (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((byte, i) => byte === b[i])}));
vi.mock('qr-code-styling', async() => {
  return {default: class QRCodeStyling {
    public _drawingPromise = Promise.resolve();

    public append(host: HTMLElement) {
      host.appendChild(document.createElement('canvas'));
    }
  }};
});

type Deferred<T> = {
  promise: Promise<T>,
  resolve: (value: T) => void,
  reject: (error: unknown) => void
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void;
  let reject: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve: resolve!, reject: reject!};
}

const TOKEN = new Uint8Array([222, 173, 190, 239]);
const EXPIRED_AT = 4_102_444_800;

function makeToken(token: Uint8Array = TOKEN) {
  return {_: 'auth.loginToken', token, expires: EXPIRED_AT};
}

async function mountCard() {
  return render(() => <SignQRCard spec={{name: 'signQR'}}/>, document.body);
}

function getButton(text: string) {
  return Array.from(document.querySelectorAll('button')).find((button) => button.textContent === text) as HTMLButtonElement | undefined;
}

async function waitForText(selector: string, text: string) {
  await vi.waitFor(() => expect(document.querySelector(selector)?.textContent).toBe(text));
}

function appendCanvas(host: HTMLElement, state?: string) {
  const canvas = document.createElement('canvas');
  canvas.className = `qr-canvas${state ? ' ' + state : ''}`;
  host.appendChild(canvas);
  return canvas;
}

describe('QR sign-in failure states', () => {
  let dispose: VoidFunction;
  let consoleSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    mocks.invokeApi.mockReset();
    mocks.invokeApi.mockRejectedValue({type: 'NETWORK_BAD_RESPONSE', code: 406, secret: 'error-secret'});
    mocks.setBaseDcId.mockReset().mockResolvedValue(undefined);
    mocks.setUser.mockReset().mockResolvedValue(undefined);
    mocks.getServerTimeOffset.mockReset().mockResolvedValue(0);
    mocks.pushToState.mockReset().mockResolvedValue(undefined);
    mocks.getUserIds.mockReset().mockResolvedValue([]);
    mocks.navigate.mockReset();
    mocks.toIm.mockReset().mockResolvedValue(undefined);
    mocks.paintQrCode.mockReset().mockImplementation(async({host}: {host: HTMLElement}) => ({canvas: appendCanvas(host)}));
    mocks.addEventListener.mockClear();
    mocks.removeEventListener.mockClear();
    mocks.clearListeners();
    mocks.privateTarget = false;
    consoleSpies = ['debug', 'info', 'log', 'warn', 'error'].map((key) => vi.spyOn(console, key as any));
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    consoleSpies.forEach((spy) => spy.mockRestore());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('shows the unsupported state only for an export rejection and keeps the username escape primary', async() => {
    mocks.privateTarget = true;
    mocks.invokeApi.mockRejectedValueOnce({type: 'INPUT_METHOD_INVALID', secret: 'export-secret'});
    dispose = await mountCard();

    await waitForText('.media-header-title', 'QR code sign-in unavailable');
    expect(document.body.textContent).toContain('This server doesn\'t support QR code sign-in.');
    expect(document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent)
    .toBe('This server doesn\'t support QR code sign-in.');
    expect(document.querySelector('.preloader')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
    expect(document.querySelector('.qr-description')).toBeNull();
    expect(getButton('Try again')).toBeUndefined();
    const escape = getButton('Sign in with username')!;
    expect(escape.classList.contains('btn-primary')).toBe(true);
    expect(escape.classList.contains('btn-color-primary')).toBe(true);
    expect(document.activeElement).toBe(escape);

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    expect(mocks.invokeApi).toHaveBeenCalledOnce();
    escape.click();
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith({name: 'signIn'});
    expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat())).toEqual(['SignQRCard: unsupported']);
    expect(document.body.innerHTML).not.toContain('export-secret');
    expect(document.body.innerHTML).not.toContain('secret-token');
  });

  it('shows a retryable state for malformed errors and accepts only one same-tick retry', async() => {
    const nextAttempt = deferred<unknown>();
    const firstAccount = {toUserId: () => 11};
    const nextAccount = {toUserId: () => 22};
    mocks.getUserIds.mockResolvedValueOnce([firstAccount]).mockResolvedValueOnce([nextAccount]);
    mocks.invokeApi
    .mockRejectedValueOnce(undefined)
    .mockReturnValueOnce(nextAttempt.promise);
    dispose = await mountCard();

    await waitForText('.media-header-title', 'Connection problem');
    expect(document.body.textContent).toContain('The QR code couldn\'t be loaded. Check your connection and try again.');
    expect(document.querySelector('.preloader')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
    expect(getButton('Log in by phone number >')?.classList.contains('btn-color-primary')).toBe(false);
    const retry = getButton('Try again')!;
    const escape = getButton('Log in by phone number >')!;
    expect(retry.classList.contains('btn-primary')).toBe(true);
    expect(retry.classList.contains('btn-color-primary')).toBe(true);
    expect(document.activeElement).toBe(retry);
    expect(mocks.invokeApi.mock.calls[0][1].except_ids).toEqual([11]);

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    expect(mocks.invokeApi).toHaveBeenCalledOnce();

    retry.click();
    retry.click();
    await vi.waitFor(() => expect(mocks.invokeApi).toHaveBeenCalledTimes(2));
    expect(getButton('Try again')).toBeUndefined();
    expect(document.querySelector('.preloader')).not.toBeNull();
    expect(document.activeElement).toBe(escape);
    expect(mocks.invokeApi.mock.calls[1][1].except_ids).toEqual([22]);
    expect(mocks.invokeApi).toHaveBeenCalledTimes(2);

    dispose();
    dispose = undefined;
    nextAttempt.resolve(makeToken());
    await Promise.resolve();
    expect(document.querySelector('canvas')).toBeNull();
    expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat()))
    .toEqual(['SignQRCard: retryable']);
  });

  it.each([null, 'private error text', {message: 'private error text'}])(
    'classifies malformed export rejection %j without exposing it', async(error) => {
      mocks.invokeApi.mockRejectedValueOnce(error);
      dispose = await mountCard();
      await waitForText('.media-header-title', 'Connection problem');

      expect(document.querySelector('.preloader')).toBeNull();
      expect(document.querySelector('canvas')).toBeNull();
      expect(document.body.innerHTML).not.toContain('private error text');
      expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat()))
      .toEqual(['SignQRCard: retryable']);
    }
  );

  it('treats INPUT_METHOD_INVALID from token import as retryable and preserves the migration DC', async() => {
    mocks.invokeApi
    .mockResolvedValueOnce({_: 'auth.loginTokenMigrateTo', dc_id: 2, token: TOKEN})
    .mockRejectedValueOnce({type: 'INPUT_METHOD_INVALID', secret: 'import-secret'})
    .mockResolvedValueOnce({_: 'auth.loginTokenMigrateTo', dc_id: 3, token: TOKEN})
    .mockRejectedValueOnce({type: 'NETWORK_BAD_RESPONSE', code: 406});
    dispose = await mountCard();

    await waitForText('.media-header-title', 'Connection problem');
    expect(mocks.setBaseDcId).toHaveBeenCalledOnce();
    expect(mocks.setBaseDcId).toHaveBeenCalledWith(2);
    expect(mocks.invokeApi.mock.calls.map(([method]) => method)).toEqual([
      'auth.exportLoginToken',
      'auth.importLoginToken'
    ]);
    expect(mocks.invokeApi.mock.calls[1][2]).toEqual({ignoreErrors: true, dcId: 2});
    expect(document.body.textContent).not.toContain('INPUT_METHOD_INVALID');
    expect(document.body.innerHTML).not.toContain('import-secret');
    getButton('Try again')!.click();
    await vi.waitFor(() => expect(mocks.invokeApi).toHaveBeenCalledTimes(4));
    expect(mocks.setBaseDcId).toHaveBeenCalledOnce();
    expect(mocks.invokeApi.mock.calls[3][2]).toEqual({ignoreErrors: true, dcId: 2});
    expect(mocks.getUserIds).toHaveBeenCalledTimes(2);
    expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat()))
    .toEqual(['SignQRCard: retryable', 'SignQRCard: retryable']);
  });

  it('does not retry after user_auth invalidates the card', async() => {
    mocks.invokeApi.mockRejectedValueOnce({type: 'NETWORK_BAD_RESPONSE'});
    dispose = await mountCard();
    await waitForText('.media-header-title', 'Connection problem');
    const retry = getButton('Try again')!;

    mocks.dispatchEvent('user_auth');
    retry.click();
    await Promise.resolve();

    expect(mocks.invokeApi).toHaveBeenCalledOnce();
    expect(getButton('Try again')).toBe(retry);
  });

  it('preserves focus on existing host controls when a failure arrives', async() => {
    const pendingExport = deferred<unknown>();
    mocks.invokeApi.mockReturnValueOnce(pendingExport.promise);
    const backButton = document.createElement('button');
    backButton.textContent = 'Back';
    const themeButton = document.createElement('button');
    themeButton.textContent = 'Theme';
    document.body.append(backButton, themeButton);
    dispose = await mountCard();
    await vi.waitFor(() => expect(mocks.invokeApi).toHaveBeenCalledOnce());
    themeButton.focus();
    pendingExport.reject({type: 'NETWORK_BAD_RESPONSE'});
    await waitForText('.media-header-title', 'Connection problem');

    expect(document.activeElement).toBe(themeButton);
    expect(getButton('Try again')).toBeDefined();
  });

  it('does not persist or import a migration response that completes after unmount', async() => {
    const pendingExport = deferred<unknown>();
    mocks.invokeApi.mockReturnValueOnce(pendingExport.promise);
    dispose = await mountCard();
    await vi.waitFor(() => expect(mocks.invokeApi).toHaveBeenCalledOnce());

    dispose();
    dispose = undefined;
    pendingExport.resolve({_: 'auth.loginTokenMigrateTo', dc_id: 4, token: TOKEN});
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.setBaseDcId).not.toHaveBeenCalled();
    expect(mocks.invokeApi).toHaveBeenCalledOnce();
    expect(mocks.setUser).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toIm).not.toHaveBeenCalled();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('does not import a migration result after the base DC update becomes stale', async() => {
    const baseDcWrite = deferred<void>();
    mocks.invokeApi.mockResolvedValueOnce({_: 'auth.loginTokenMigrateTo', dc_id: 4, token: TOKEN});
    mocks.setBaseDcId.mockReturnValueOnce(baseDcWrite.promise);
    dispose = await mountCard();
    await vi.waitFor(() => expect(mocks.setBaseDcId).toHaveBeenCalledWith(4));

    dispose();
    dispose = undefined;
    baseDcWrite.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.invokeApi).toHaveBeenCalledOnce();
    expect(mocks.setUser).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toIm).not.toHaveBeenCalled();
  });

  it('does not publish an import result that completes after unmount', async() => {
    const pendingImport = deferred<unknown>();
    mocks.invokeApi
    .mockResolvedValueOnce({_: 'auth.loginTokenMigrateTo', dc_id: 4, token: TOKEN})
    .mockReturnValueOnce(pendingImport.promise);
    dispose = await mountCard();
    await vi.waitFor(() => expect(mocks.invokeApi).toHaveBeenCalledTimes(2));

    dispose();
    dispose = undefined;
    pendingImport.resolve({_: 'auth.loginTokenSuccess', authorization: {user: {id: 42}}});
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.setUser).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toIm).not.toHaveBeenCalled();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('drops a pending theme repaint after failure and its reveal timers cannot restore the canvas', async() => {
    const polling = deferred<void>();
    const repaint = deferred<{canvas: HTMLCanvasElement}>();
    const initialToken = makeToken(new Uint8Array([1, 2, 3]));
    mocks.invokeApi
    .mockResolvedValueOnce(initialToken)
    .mockRejectedValueOnce({type: 'NETWORK_BAD_RESPONSE', code: 406});
    mocks.paintQrCode
    .mockImplementationOnce(async({host}: {host: HTMLElement}) => ({canvas: appendCanvas(host)}))
    .mockImplementationOnce(({host}: {host: HTMLElement}) => {
      const canvas = appendCanvas(host);
      return repaint.promise.then(() => ({canvas}));
    });
    const pause = await import('@helpers/schedulers/pause');
    vi.mocked(pause.default).mockReturnValueOnce(polling.promise);
    dispose = await mountCard();

    await vi.waitFor(() => expect(document.querySelector('canvas')).not.toBeNull());
    mocks.dispatchEvent('theme_changed');
    await vi.waitFor(() => expect(mocks.paintQrCode).toHaveBeenCalledTimes(2));
    polling.resolve();
    await waitForText('.media-header-title', 'Connection problem');
    repaint.resolve({canvas: document.createElement('canvas')});
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(document.querySelector('canvas')).toBeNull();
    expect(document.querySelector('.preloader')).toBeNull();
    mocks.dispatchEvent('theme_changed');
    expect(mocks.paintQrCode).toHaveBeenCalledTimes(2);
  });

  it('lets the newest token paint win over an older theme repaint', async() => {
    const firstPoll = deferred<void>();
    const secondPoll = deferred<void>();
    const oldThemePaint = deferred<{canvas: HTMLCanvasElement}>();
    mocks.invokeApi
    .mockResolvedValueOnce(makeToken(new Uint8Array([1])))
    .mockResolvedValueOnce(makeToken(new Uint8Array([2])));
    const pause = await import('@helpers/schedulers/pause');
    vi.mocked(pause.default).mockReturnValueOnce(firstPoll.promise).mockReturnValueOnce(secondPoll.promise);
    mocks.paintQrCode
    .mockImplementationOnce(async({host}: {host: HTMLElement}) => ({canvas: appendCanvas(host, 'paint-one')}))
    .mockImplementationOnce(({host}: {host: HTMLElement}) => {
      const canvas = appendCanvas(host, 'paint-old-theme');
      return oldThemePaint.promise.then(() => ({canvas}));
    })
    .mockImplementationOnce(async({host}: {host: HTMLElement}) => ({canvas: appendCanvas(host, 'paint-new-token')}));
    dispose = await mountCard();

    await vi.waitFor(() => expect(document.querySelector('canvas.paint-one')).not.toBeNull());
    mocks.dispatchEvent('theme_changed');
    await vi.waitFor(() => expect(mocks.paintQrCode).toHaveBeenCalledTimes(2));
    firstPoll.resolve();
    await vi.waitFor(() => expect(document.querySelector('canvas.paint-new-token')).not.toBeNull());
    oldThemePaint.resolve({canvas: document.createElement('canvas')});
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    expect(document.querySelector('canvas.paint-new-token')).not.toBeNull();
    dispose();
    dispose = undefined;
    secondPoll.resolve();
  });

  it('treats QR drawing failures as retryable without exposing their details', async() => {
    mocks.invokeApi.mockResolvedValueOnce(makeToken());
    mocks.paintQrCode.mockRejectedValueOnce({type: 'INPUT_METHOD_INVALID', secret: 'paint-secret'});
    dispose = await mountCard();

    await waitForText('.media-header-title', 'Connection problem');
    expect(document.querySelector('.preloader')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
    expect(document.body.innerHTML).not.toContain('paint-secret');
    expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat()))
    .toEqual(['SignQRCard: retryable']);
  });

  it('recovers from a logo fetch failure when Try again runs the real QR painter', async() => {
    const successfulResponse = {ok: true, text: vi.fn().mockResolvedValue('<svg style="fill:#000;"></svg>')};
    const fetchMock = vi.fn()
    .mockRejectedValueOnce(new Error('private logo fetch detail'))
    .mockResolvedValue(successfulResponse);
    vi.stubGlobal('fetch', fetchMock);
    const {paintQrCode} = await vi.importActual<typeof import('@helpers/qrCode/paintQrCode')>(
      '@helpers/qrCode/paintQrCode'
    );
    const pendingPoll = deferred<void>();
    const pause = await import('@helpers/schedulers/pause');
    vi.mocked(pause.default).mockReturnValueOnce(pendingPoll.promise);
    mocks.invokeApi.mockResolvedValueOnce(makeToken()).mockResolvedValueOnce(makeToken());
    mocks.paintQrCode.mockImplementation(paintQrCode);
    dispose = await mountCard();

    await waitForText('.media-header-title', 'Connection problem');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(document.querySelector('canvas')).toBeNull();
    expect(document.body.innerHTML).not.toContain('private logo fetch detail');
    expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat()))
    .toEqual(['SignQRCard: retryable']);

    getButton('Try again')!.click();
    await vi.waitFor(() => expect(document.querySelector('canvas')).not.toBeNull());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(successfulResponse.text).toHaveBeenCalledOnce();
    expect(document.querySelector('.media-header-title')?.textContent).toBe('Log in by QR Code');
    expect(document.querySelector('.media-header-subtitle')?.textContent).toBe('Scan with Telegram app on your phone');
    expect(document.querySelector<HTMLElement>('.preloader')?.style.animation).toBe('hide-icon .4s forwards');
    expect(mocks.invokeApi).toHaveBeenCalledTimes(2);
    expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat()))
    .toEqual(['SignQRCard: retryable']);

    dispose();
    dispose = undefined;
    pendingPoll.resolve();
  });

  it('lets setUser dispatch user_auth before its promise resolves and still enters chats once', async() => {
    const pendingUser = deferred<void>();
    const user = {_: 'user', id: 42};
    mocks.invokeApi.mockResolvedValueOnce({
      _: 'auth.loginTokenSuccess',
      authorization: {_: 'auth.authorization', user}
    });
    mocks.setUser.mockImplementationOnce(() => {
      mocks.dispatchEvent('user_auth');
      return pendingUser.promise;
    });
    dispose = await mountCard();

    await vi.waitFor(() => expect(mocks.setUser).toHaveBeenCalledWith(user));
    expect(mocks.toIm).not.toHaveBeenCalled();
    pendingUser.resolve();
    await vi.waitFor(() => expect(mocks.toIm).toHaveBeenCalledOnce());
    expect(mocks.toIm).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.invokeApi).toHaveBeenCalledOnce();
  });

  it('keeps password-required navigation and expired-token polling intact', async() => {
    mocks.invokeApi
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'})
    .mockRejectedValueOnce({type: 'AUTH_TOKEN_EXPIRED'})
    .mockRejectedValueOnce({type: 'NETWORK_BAD_RESPONSE'});
    dispose = await mountCard();

    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({name: 'password'}));
    expect(mocks.navigate).toHaveBeenCalledOnce();
    dispose();
    dispose = undefined;
    document.body.replaceChildren();
    mocks.clearListeners();
    mocks.invokeApi.mockReset();
    mocks.invokeApi
    .mockRejectedValueOnce({type: 'AUTH_TOKEN_EXPIRED'})
    .mockRejectedValueOnce({type: 'NETWORK_BAD_RESPONSE'});
    dispose = await mountCard();

    await waitForText('.media-header-title', 'Connection problem');
    expect(mocks.invokeApi).toHaveBeenCalledTimes(2);
    expect(consoleSpies.flatMap((spy) => spy.mock.calls.flat()))
    .toEqual(['SignQRCard: AUTH_TOKEN_EXPIRED', 'SignQRCard: retryable']);
  });
});
