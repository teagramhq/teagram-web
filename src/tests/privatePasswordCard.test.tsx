import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  check: vi.fn(),
  requestRecovery: vi.fn(),
  deleteAccount: vi.fn(),
  pushToState: vi.fn(),
  navigate: vi.fn(),
  toIm: vi.fn(),
  showConfirmation: vi.fn(),
  anchorCallback: vi.fn(),
  toastNew: vi.fn()
}));

vi.mock('@/pages/authFlow', () => ({
  useAuthFlow: () => ({
    managers: {
      passwordManager: {
        getState: mocks.getState,
        check: mocks.check,
        requestRecovery: mocks.requestRecovery
      },
      appAccountManager: {deleteAccount: mocks.deleteAccount},
      appStateManager: {pushToState: mocks.pushToState}
    },
    navigate: mocks.navigate,
    toIm: mocks.toIm
  })
}));

vi.mock('@components/buttonTsx', () => ({
  default: (props: any) => (
    <button class={props.class} disabled={props.disabled} onClick={props.onClick}>
      {props.children ?? props.text}
    </button>
  )
}));

vi.mock('@components/mediaHeader', () => {
  const Header = (props: any) => <header>{props.children}</header>;
  Header.Sticker = (props: any) => <div>{props.element}</div>;
  Header.Title = (props: any) => <h1>{props.children}</h1>;
  Header.Subtitle = (props: any) => <p>{props.children}</p>;
  return {default: Header};
});

vi.mock('@components/monkeys/password', () => ({
  default: class {
    container = document.createElement('div');
    load() {
      return Promise.resolve();
    }
    remove() {}
  }
}));

vi.mock('@components/passwordInputField', () => ({
  default: class {
    container = document.createElement('div');
    input = document.createElement('input');
    helpers = {};
    label = document.createElement('label');
    constructor(options: {label?: string}) {
      this.input.type = 'password';
      this.input.setAttribute('aria-label', options.label ?? 'Password');
      this.container.append(this.input);
    }
    setValueSilently(value: string) {
      this.input.value = value;
    }
    setLabel() {}
  }
}));

vi.mock('@components/popups/simpleConfirmation', () => ({SimpleConfirmationPopup: {show: mocks.showConfirmation}}));
vi.mock('@components/toast', () => ({toastNew: mocks.toastNew}));
vi.mock('@components/wrappers/wrapDuration', () => ({wrapFormattedDuration: vi.fn()}));
vi.mock('@helpers/dom/anchorCallback', () => ({default: mocks.anchorCallback}));
vi.mock('@helpers/dom/focusWhenConnected', () => ({default: vi.fn(() => () => {})}));
vi.mock('@helpers/dom/htmlToSpan', () => ({default: vi.fn()}));
vi.mock('@helpers/formatDuration', () => ({default: vi.fn()}));
vi.mock('@helpers/mediaSizes', () => ({default: {isMobile: false}}));
vi.mock('@lib/langPack', () => ({
  i18n: (key: string) => {
    const element = document.createElement('span');
    element.textContent = key;
    return element;
  }
}));
vi.mock('@lib/richTextProcessor/wrapEmojiText', () => ({default: vi.fn()}));
vi.mock('@lib/customEmoji/renderer', () => ({CustomEmojiRendererElement: {create: vi.fn()}}));
vi.mock('@lib/richTextProcessor/wrapRichText', () => ({
  createCustomFiller: vi.fn(),
  insertCustomFillers: vi.fn(),
  default: vi.fn()
}));

import PrivatePasswordCard from '@/pages/cards/PrivatePasswordCard';
import {clearPrivateUsernameLogin, isPrivateUsernameLogin, markPrivateUsernameLogin} from '@/pages/privateUsernameLoginState';

describe('private password card', () => {
  let dispose: VoidFunction;

  beforeEach(() => {
    mocks.getState.mockReset().mockResolvedValue({hint: ''});
    mocks.check.mockReset().mockRejectedValue({type: 'PASSWORD_HASH_INVALID'});
    mocks.requestRecovery.mockReset().mockResolvedValue({email_pattern: 'a***@example.test'});
    mocks.deleteAccount.mockReset().mockResolvedValue(undefined);
    mocks.pushToState.mockReset();
    mocks.navigate.mockReset();
    mocks.toIm.mockReset();
    mocks.showConfirmation.mockReset().mockResolvedValue(undefined);
    mocks.anchorCallback.mockReset().mockImplementation(() => vi.fn());
    mocks.toastNew.mockReset();
    clearPrivateUsernameLogin();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    clearPrivateUsernameLogin();
    document.body.replaceChildren();
  });

  async function mount() {
    dispose = render(() => <PrivatePasswordCard spec={{name: 'password'}}/>, document.body);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return document.querySelector('input[aria-label="LoginPassword"]') as HTMLInputElement;
  }

  it('shows one generic error for a wrong password after username sign-in', async() => {
    markPrivateUsernameLogin();
    const input = await mount();
    input.value = 'mock-password';
    (document.querySelector('button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('invalid username or password');
    expect(document.body.textContent).not.toContain('PASSWORD_HASH_INVALID');
    expect(mocks.check).toHaveBeenCalledWith('mock-password', {hint: ''});
    expect(mocks.pushToState).toHaveBeenCalledWith('authState', {_: 'authStatePassword'});
  });

  it('retains the existing password error for a different sign-in method', async() => {
    const input = await mount();
    input.value = 'mock-password';
    (document.querySelector('button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('button')?.textContent).toBe('PASSWORD_HASH_INVALID');
  });

  it('keeps the existing SRP success path', async() => {
    const user = {_: 'user', id: 42};
    mocks.check.mockResolvedValue({_: 'auth.authorization', user});
    const input = await mount();
    input.value = 'mock-password';
    (document.querySelector('button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.toIm).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not log a raw account reset failure from the private password flow', async() => {
    markPrivateUsernameLogin();
    await mount();
    mocks.requestRecovery.mockRejectedValue({type: 'PASSWORD_RECOVERY_NA'});
    const resetError = {type: 'ACCOUNT_RESET_FAILED', code: 500, phone_number: 'Alice_123'};
    mocks.deleteAccount.mockRejectedValue(resetError);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onForgotPassword = mocks.anchorCallback.mock.calls[0]?.[0] as (() => void) | undefined;

    expect(onForgotPassword).toBeTypeOf('function');
    onForgotPassword!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.deleteAccount).toHaveBeenCalledWith('Forgot password');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('Alice_123');
    expect(consoleError.mock.calls.flat()).not.toContain(resetError);
    expect(mocks.toastNew).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('clears the transient username-flow marker when password card is cancelled', async() => {
    markPrivateUsernameLogin();
    await mount();

    dispose();
    dispose = undefined;

    expect(isPrivateUsernameLogin()).toBe(false);
  });
});
