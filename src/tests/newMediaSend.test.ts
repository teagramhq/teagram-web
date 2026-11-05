import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import deferredPromise from '@helpers/cancellablePromise';

const mocks = vi.hoisted(() => {
  const noop = vi.fn();
  return {
    toastNew: vi.fn(),
    apiManagerProxy: new Proxy({}, {get: () => noop}),
    sidebar: new Proxy({}, {get: () => noop}),
    rootScope: {
      myId: 0,
      premium: false,
      managers: new Proxy({}, {get: () => ({})}),
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: noop,
      dispatchEventSingle: noop
    }
  };
});

vi.mock('@components/toast', () => ({toastNew: mocks.toastNew, toast: vi.fn()}));
vi.mock('@lib/apiManagerProxy', () => ({default: mocks.apiManagerProxy}));
vi.mock('@lib/rootScope', () => ({default: mocks.rootScope}));
vi.mock('@components/sidebarLeft', () => ({default: mocks.sidebar}));
vi.mock('@components/sidebarRight', () => ({default: mocks.sidebar}));
vi.mock('@stores/contentSettings', () => ({
  default: () => ({
    sensitiveEnabled: () => false,
    sensitiveCanChange: () => false,
    needAgeVerification: () => false,
    ageVerified: () => false,
    ignoreRestrictionReasons: (): string[] => []
  })
}));
vi.mock('@stores/stars', () => ({default: () => () => 0}));

let PopupNewMedia: typeof import('@components/popups/newMedia').default;

beforeAll(async() => {
  class IntersectionObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class WorkerMock {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    start() {}
    terminate() {}
  }

  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
  vi.stubGlobal('Worker', WorkerMock);
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  vi.stubGlobal('CSS', {supports: () => false, escape: (value: string) => value});
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/webp;base64,');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  ({default: PopupNewMedia} = await import('@components/popups/newMedia'));
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('new media send', () => {
  it.each([
    {type: 'media', name: 'photo.jpg', mimeType: 'image/jpeg', isMedia: true},
    {type: 'document', name: 'document.pdf', mimeType: 'application/pdf', isMedia: undefined}
  ])('shows an error after a rejected $type send', async({type, name, mimeType, isMedia}) => {
    const file = new File(['data'], name, {type: mimeType});
    const pendingSend = deferredPromise<void>();
    const sendGrouped = vi.fn(() => pendingSend);
    const resetSendingFlags = vi.fn();
    const hide = vi.fn();
    const input = {
      verifyEphemeralCommand: () => true,
      getEphemeralCommandResolution: () => ({state: 'none'}),
      showSlowModeTooltipIfNeeded: async() => false,
      paidMessageInterceptor: {prepareStarsForPayment: async(): Promise<void> => undefined},
      resetSendingFlags
    };
    const popup = Object.assign(Object.create(PopupNewMedia.prototype), {
      fileConversions: new Map(),
      convertedFiles: new WeakMap(),
      failedConversions: new WeakSet(),
      files: [file],
      messageInputField: {input: document.createElement('div')},
      captionLengthMax: 1024,
      btnConfirm: document.createElement('button'),
      willAttach: {type, group: false, sendFileDetails: [{file}]},
      chat: {type: 'chat', input, getMessageSendingParams: () => ({peerId: 1 as PeerId})},
      managers: {appMessagesManager: {sendGrouped}},
      starsState: {totalMessages: () => 1},
      hide
    });
    vi.spyOn(PopupNewMedia, 'canSend').mockResolvedValue({
      send_photos: true, send_videos: true, send_docs: true, send_audios: true, send_gifs: true
    });

    await popup.send();

    expect(sendGrouped).toHaveBeenCalledWith(expect.objectContaining({
      peerId: 1, isMedia, sendFileDetails: [expect.objectContaining({file})]
    }));
    expect(hide).toHaveBeenCalledOnce();
    expect(resetSendingFlags).toHaveBeenCalledOnce();
    expect(mocks.toastNew).not.toHaveBeenCalled();

    pendingSend.reject({type: 'UPLOAD_DISABLED', code: 403});
    await vi.waitFor(() => expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Error.AnError'}));
  });
});
