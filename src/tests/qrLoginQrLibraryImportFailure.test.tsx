import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';
import SignQRCard from '@/pages/cards/SignQRCard';

const mocks = vi.hoisted(() => ({
  invokeApi: vi.fn(),
  pushToState: vi.fn(),
  getUserIds: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn()
}));

vi.mock('@/pages/authFlow', () => ({
  useAuthFlow: () => ({
    managers: {
      apiManager: {invokeApi: mocks.invokeApi},
      appStateManager: {pushToState: mocks.pushToState},
      timeManager: {getServerTimeOffset: vi.fn()}
    },
    navigate: vi.fn(),
    toIm: vi.fn()
  })
}));
vi.mock('@config/mtprotoTarget', () => ({isPrivateMtprotoTarget: () => false}));
vi.mock('@lib/accounts/accountController', () => ({default: {getUserIds: mocks.getUserIds}}));
vi.mock('@lib/accounts/getCurrentAccount', () => ({getCurrentAccount: () => 1}));
vi.mock('@lib/rootScope', () => ({default: {
  addEventListener: mocks.addEventListener,
  removeEventListener: mocks.removeEventListener
}}));
vi.mock('@lib/langPack', () => ({i18n: (key: string) => ({
  'Login.QR.Title': 'Log in by QR Code',
  'Login.QR.Subtitle': 'Scan with Telegram app on your phone',
  'Login.QR.Error.Title': 'Connection problem',
  'Login.QR.Error.Text': 'The QR code couldn\'t be loaded. Check your connection and try again.',
  'Login.QR.Retry': 'Try again',
  'Login.QR.Cancel': 'Log in by phone number >'
} as Record<string, string>)[key] || key}));
vi.mock('@components/buttonTsx', () => ({default: (props: any) => (
  <button ref={props.ref} class={props.class} onClick={props.onClick}>
    {props.text === 'Login.QR.Retry' ? 'Try again' : props.text === 'Login.QR.Cancel' ? 'Log in by phone number >' : props.text}
  </button>
)}));
vi.mock('@components/iconTsx', () => ({IconTsx: (props: any) => <span>{props.icon}</span>}));
vi.mock('@components/putPreloader', () => ({putPreloader: (host: HTMLElement) => {
  const element = document.createElement('div');
  element.className = 'preloader';
  host.appendChild(element);
  return element;
}}));
vi.mock('@components/languageChangeButton', () => ({default: () => <button>Language</button>}));
vi.mock('@components/passkeyLoginButton', () => ({default: () => <button>Passkey</button>}));
vi.mock('@helpers/bytes/bytesCmp', () => ({default: vi.fn()}));
vi.mock('@helpers/bytes/bytesToBase64', () => ({default: vi.fn()}));
vi.mock('@helpers/fixBase64String', () => ({default: vi.fn()}));
vi.mock('@helpers/qrCode/paintQrCode', () => ({paintQrCode: vi.fn()}));
vi.mock('@helpers/schedulers/pause', () => ({default: vi.fn()}));
vi.mock('@config/app', () => ({default: {id: 1, hash: 'test'}}));
vi.mock('@/pages/AuthCard', () => ({default: (props: any) => <div>{props.header}{props.children}</div>}));
vi.mock('@/pages/authFlow.module.scss', () => ({default: {
  pageSignQR: 'page-sign-qr', qrDescription: 'qr-description', qrDescriptionItem: 'qr-description-item',
  qrDescriptionMarker: 'qr-description-marker', qrContainer: 'qr-container', qrCanvas: 'qr-canvas', qrStateIcon: 'qr-state-icon'
}}));
vi.mock('@components/mediaHeader.module.scss', () => ({default: {
  container: 'media-header-container', sticker: 'media-header-sticker', title: 'media-header-title',
  subtitle: 'media-header-subtitle', secondary: 'media-header-secondary'
}}));
vi.mock('@helpers/string/classNames', () => ({default: (...values: Array<string | undefined | false>) => values.filter(Boolean).join(' ')}));
vi.mock('qr-code-styling', async() => {
  throw new Error('private QR library import detail');
});

let dispose: VoidFunction;
let consoleWarn: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.invokeApi.mockReset();
  mocks.pushToState.mockReset().mockResolvedValue(undefined);
  mocks.getUserIds.mockReset().mockResolvedValue([]);
  mocks.addEventListener.mockReset();
  mocks.removeEventListener.mockReset();
  consoleWarn = vi.spyOn(console, 'warn');
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  consoleWarn.mockRestore();
  consoleError.mockRestore();
  document.body.replaceChildren();
});

it('shows a retryable state when qr-code-styling cannot be imported', async() => {
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
    event.preventDefault();
  };
  window.addEventListener('unhandledrejection', onUnhandled);
  dispose = render(() => <SignQRCard spec={{name: 'signQR'}}/>, document.body);

  await vi.waitFor(() => expect(document.querySelector('.media-header-title')?.textContent).toBe('Connection problem'));
  expect(document.body.textContent).toContain('The QR code couldn\'t be loaded. Check your connection and try again.');
  expect(document.querySelector('.preloader')).toBeNull();
  expect(document.querySelector('button')?.textContent).toBe('Try again');
  expect(mocks.invokeApi).not.toHaveBeenCalled();
  expect(consoleWarn).toHaveBeenCalledExactlyOnceWith('SignQRCard: retryable');
  expect(consoleError).not.toHaveBeenCalled();
  expect(unhandled).toEqual([]);
  expect(document.body.innerHTML).not.toContain('private QR library import detail');
  window.removeEventListener('unhandledrejection', onUnhandled);
});
