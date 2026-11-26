import {beforeEach, describe, expect, it, vi} from 'vitest';
import {openEmojiStatusPicker} from '@components/sidebarLeft/emojiStatusPicker';

const mocks = vi.hoisted(() => ({
  initPromise: undefined as Promise<void> | undefined,
  initContinuation: undefined as Promise<void> | undefined,
  rejectInit: undefined as ((error: unknown) => void) | undefined,
  destroyError: undefined as unknown,
  emojiTabOptions: undefined as any,
  dropdown: undefined as any,
  updateEmojiStatus: vi.fn()
}));

vi.mock('@components/emoticonsDropdown/tabs/emoji', () => ({
  default: class {
    public initPromise: Promise<void>;

    constructor(options: any) {
      mocks.emojiTabOptions = options;
      this.initPromise = mocks.initPromise;
    }

    public destroy() {
      mocks.rejectInit(mocks.destroyError);
    }
  }
}));

vi.mock('@components/emoticonsDropdown', () => ({
  EmoticonsDropdown: class {
    private listeners = new Map<string, VoidFunction>();
    private closed = false;
    private tabs: any[];

    constructor(options: any) {
      this.tabs = options.tabsToRender;
      mocks.dropdown = this;
    }

    public addEventListener(event: string, listener: VoidFunction) {
      this.listeners.set(event, listener);
    }

    public setTextColor() {}

    public onButtonClick() {}

    public toggle(open: boolean) {
      if(!open && !this.closed) {
        this.closed = true;
        this.listeners.get('closed')?.();
      }

      return Promise.resolve();
    }

    public hideAndDestroy() {
      return this.toggle(false).then(() => {
        this.tabs.forEach((tab) => tab.destroy());
      });
    }
  }
}));

vi.mock('@components/icon', () => ({
  default: () => document.createElement('span'),
  getIconContent: () => '⭐'
}));

vi.mock('@helpers/appWindow', () => ({getOverlayRoot: () => document.body}));
vi.mock('@components/sidebarLeft/emojiStatus', () => ({optionalStatuses: (promise: Promise<unknown>) => promise}));

function createPendingInit() {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  const originalThen = promise.then.bind(promise);

  vi.spyOn(promise, 'then').mockImplementation(((onFulfilled: any, onRejected: any) => {
    const continuation = originalThen(onFulfilled, onRejected);
    mocks.initContinuation = continuation;
    return continuation;
  }) as any);

  mocks.initPromise = promise;
  mocks.rejectInit = reject;
  return reject;
}

function openPicker() {
  openEmojiStatusPicker({
    managers: {appUsersManager: {updateEmojiStatus: mocks.updateEmojiStatus}} as any,
    anchorElement: document.createElement('button')
  });
}

describe('emoji status picker init cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initPromise = undefined;
    mocks.initContinuation = undefined;
    mocks.rejectInit = undefined;
    mocks.destroyError = undefined;
    mocks.emojiTabOptions = undefined;
    mocks.dropdown = undefined;
  });

  it('consumes teardown cancellation, applies the selection, and propagates other init failures', async() => {
    createPendingInit();
    mocks.destroyError = {type: 'MIDDLEWARE'};
    openPicker();

    const cancellationHandled = expect(mocks.initContinuation).resolves.toBeUndefined();
    await mocks.emojiTabOptions.onClick({emoji: '🔥', docId: '42'});
    await cancellationHandled;

    expect(mocks.updateEmojiStatus).toHaveBeenCalledWith({
      _: 'emojiStatus',
      document_id: '42'
    });

    const initError = new Error('emoji status init failed');
    createPendingInit();
    mocks.destroyError = initError;
    openPicker();

    const errorSurfaces = expect(mocks.initContinuation).rejects.toBe(initError);
    await mocks.emojiTabOptions.onClick({emoji: '🔥', docId: '42'});
    await errorSurfaces;
  });
});
