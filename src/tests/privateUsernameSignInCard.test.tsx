import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';

const mocks = vi.hoisted(() => ({
  invokeApi: vi.fn(),
  getAppConfig: vi.fn(),
  updatePasswordSettings: vi.fn(),
  setUser: vi.fn(),
  pushToState: vi.fn(),
  navigate: vi.fn(),
  toIm: vi.fn()
}));

vi.mock('@/pages/authFlow', () => ({
  useAuthFlow: () => ({
    managers: {
      apiManager: {invokeApi: mocks.invokeApi, getAppConfig: mocks.getAppConfig, setUser: mocks.setUser},
      passwordManager: {updateSettings: mocks.updatePasswordSettings},
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

vi.mock('@components/languageChangeButton', () => ({default: (): null => null}));
vi.mock('@lib/langPack', async(importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/langPack')>();
  return {
    ...actual,
    i18n: (key: string) => {
    const copy: Record<string, string> = {
      'Teagram.Registration.CreateAccount': 'Create account',
      'Teagram.Registration.SignIn': 'Sign in',
      'Teagram.Registration.Subtitle': 'Create your account',
      'Teagram.Registration.DisplayName': 'Display name',
      'Teagram.Registration.Password': 'Password',
      'Teagram.Registration.ConfirmPassword': 'Confirm password',
      'Teagram.Registration.InviteSecret': 'Invite secret',
      'Teagram.Registration.PasswordMismatch': 'Those passwords don\'t match.',
      'Teagram.Registration.UsernameTaken': 'That username is taken.',
      'Teagram.Registration.InvalidUsername': 'Choose a valid username.',
      'Teagram.Registration.InvalidDisplayName': 'Enter a display name.',
      'Teagram.Registration.InvalidInvite': 'That invite secret is invalid.',
      'Teagram.Registration.Closed': 'Account creation is closed on this server.',
      'Teagram.Registration.WeakPassword': 'Choose a stronger password.',
      'Teagram.Registration.Network': 'Unable to create your account. Try again.',
      'Teagram.Registration.PasswordNetwork': 'Unable to set your password. Try again.',
      'Teagram.Registration.ConfigNetwork': 'Unable to check whether account creation is available.'
    };
    const span = document.createElement('span');
    span.textContent = copy[key] || key;
      return span;
    }
  };
});
vi.mock('@environment/touchSupport', () => ({default: true}));
vi.mock('@helpers/dom/focusWhenConnected', () => ({default: vi.fn(() => () => {})}));
vi.mock('@lib/accounts/getCurrentAccount', () => ({getCurrentAccount: () => 1}));
vi.mock('@lib/customEmoji/renderer', () => ({
  CustomEmojiRendererElement: {create: vi.fn()}
}));
vi.mock('@lib/richTextProcessor/wrapRichText', () => ({
  createCustomFiller: vi.fn(),
  insertCustomFillers: vi.fn(),
  default: vi.fn()
}));

import PrivateSignInCard from '@/pages/cards/PrivateSignInCard';
import {clearPrivateUsernameLogin, isPrivateUsernameLogin} from '@/pages/privateUsernameLoginState';

const SENT_CODE = {
  _: 'auth.sentCode',
  phone_code_hash: 'mock-code-hash',
  type: {_ : 'auth.sentCodeTypeApp', length: 5},
  timeout: 60
};
const USERNAME = 'Alice_123';

describe('private username sign-in card', () => {
  let dispose: VoidFunction;
  let storageWrites: ReturnType<typeof vi.spyOn>[];
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.invokeApi.mockReset();
    mocks.getAppConfig.mockReset().mockResolvedValue({registration_mode: 'closed'});
    mocks.updatePasswordSettings.mockReset();
    mocks.setUser.mockReset();
    mocks.pushToState.mockReset();
    mocks.navigate.mockReset();
    mocks.toIm.mockReset();
    clearPrivateUsernameLogin();
    storageWrites = [
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'removeItem')
    ];
    consoleError = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    clearPrivateUsernameLogin();
    storageWrites.forEach((spy) => spy.mockRestore());
    consoleError.mockRestore();
    document.body.replaceChildren();
  });

  function mount() {
    dispose = render(() => <PrivateSignInCard spec={{name: 'signIn'}}/>, document.body);
    return document.querySelector('input[aria-label="Username"]') as HTMLInputElement;
  }

  async function flushAuthFlow() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('rejects invalid input without an authentication call', () => {
    const input = mount();
    input.value = 'bad';
    input.dispatchEvent(new Event('input', {bubbles: true}));

    const next = document.querySelector('button') as HTMLButtonElement;
    expect(input.type).toBe('text');
    expect(input.autocomplete).toBe('off');
    expect(input.name).toBe('');
    expect(next.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    next.click();

    expect(mocks.invokeApi).not.toHaveBeenCalled();
    expect(mocks.pushToState).toHaveBeenCalledWith('authState', {_: 'authStateSignIn'});
  });

  it('sends the username with an empty code and enters the existing password card', async() => {
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'});
    const input = mount();
    const next = document.querySelector('button') as HTMLButtonElement;
    input.value = USERNAME;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    next.click();
    await flushAuthFlow();

    expect(mocks.invokeApi).toHaveBeenNthCalledWith(1, 'auth.sendCode', expect.objectContaining({phone_number: USERNAME}));
    expect(mocks.invokeApi).toHaveBeenNthCalledWith(2, 'auth.signIn', {
      phone_number: USERNAME,
      phone_code_hash: 'mock-code-hash',
      phone_code: ''
    }, {ignoreErrors: true});
    expect(mocks.navigate).toHaveBeenCalledWith({name: 'password'});
    expect(isPrivateUsernameLogin()).toBe(true);
    expect(input.value).toBe('');
    expect(mocks.pushToState.mock.calls).toEqual([['authState', {_: 'authStateSignIn'}]]);
    const hasStoredUsername = storageWrites.some((spy) =>
      spy.mock.calls.some((call: unknown[]) => call.some((value: unknown) => String(value).includes(USERNAME)))
    );
    expect(hasStoredUsername).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('finishes an authorization returned by username sign-in', async() => {
    const user = {_: 'user', id: 42};
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorization', user});
    const input = mount();
    input.value = USERNAME;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    (document.querySelector('button') as HTMLButtonElement).click();
    await flushAuthFlow();

    expect(mocks.setUser).toHaveBeenCalledWith(user);
    expect(mocks.toIm).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('shows the same credential error for sign-up-required and never offers registration', async() => {
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}});
    const input = mount();
    input.value = USERNAME;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    (document.querySelector('button') as HTMLButtonElement).click();
    await flushAuthFlow();

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('invalid username or password');
    expect(document.body.textContent).not.toMatch(/sign up|create account/i);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('shows a create-account path when the server allows open registration', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));

    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true);
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    expect(document.querySelector('input[aria-label="Display name"]')).not.toBeNull();
    expect(document.querySelector('input[aria-label="Password"]')).not.toBeNull();
    expect(document.querySelector('input[aria-label="Confirm password"]')).not.toBeNull();
    expect(document.querySelector('input[aria-label="Invite secret"]')).toBeNull();
  });

  it('asks for an invite secret in invite registration mode', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'invite'});
    mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    expect(document.querySelector('input[aria-label="Invite secret"]')).not.toBeNull();
  });

  it('lets the user sign in with the same username after registration reports it is taken', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockRejectedValueOnce({type: 'USERNAME_OCCUPIED'})
    .mockResolvedValueOnce(SENT_CODE)
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'});
    const input = mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    const fill = (label: string, value: string) => {
      const field = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new Event('input', {bubbles: true}));
    };
    fill('Username', USERNAME);
    fill('Display name', 'Alice Example');
    fill('Password', 'StrongPassword123');
    fill('Confirm password', 'StrongPassword123');
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('That username is taken.'));

    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Sign in') as HTMLButtonElement).click();
    const next = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Next') as HTMLButtonElement;
    expect(input.value).toBe(USERNAME);
    expect(next.disabled).toBe(false);
    next.click();
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({name: 'password'}));

    expect(mocks.invokeApi.mock.calls.map(([method]) => method)).toEqual([
      'auth.sendCode',
      'auth.signIn',
      'auth.signUp',
      'auth.sendCode',
      'auth.signIn'
    ]);
    expect(mocks.invokeApi).toHaveBeenNthCalledWith(4, 'auth.sendCode', expect.objectContaining({phone_number: USERNAME}));
  });

  it('re-enables sign-in when the server closes registration during sign-up', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockRejectedValueOnce({type: 'INPUT_REQUEST_INVALID'});
    const input = mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    const fill = (label: string, value: string) => {
      const field = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new Event('input', {bubbles: true}));
    };
    fill('Username', USERNAME);
    fill('Display name', 'Alice Example');
    fill('Password', 'StrongPassword123');
    fill('Confirm password', 'StrongPassword123');
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('Account creation is closed on this server.'));

    const next = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Next') as HTMLButtonElement;
    expect(input.value).toBe(USERNAME);
    expect(next.disabled).toBe(false);
  });

  it('sets the password before opening the new account', async() => {
    const user = {_: 'user', id: 42};
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockResolvedValueOnce({_: 'auth.authorization', user});
    mocks.updatePasswordSettings.mockResolvedValue(true);
    mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    const fill = (label: string, value: string) => {
      const input = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    };
    fill('Username', USERNAME);
    fill('Display name', 'Alice Example');
    fill('Password', 'StrongPassword123');
    fill('Confirm password', 'StrongPassword123');
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.toIm).toHaveBeenCalledOnce());

    expect(mocks.invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn', 'auth.signUp']);
    expect(mocks.updatePasswordSettings).toHaveBeenCalledWith({newPassword: 'StrongPassword123'});
    expect(mocks.setUser).toHaveBeenCalledWith(user);
  });

  it('keeps a provisional account in the registration form when password setup fails and lets the user retry', async() => {
    const user = {_: 'user', id: 43};
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockResolvedValueOnce({_: 'auth.authorization', user});
    mocks.updatePasswordSettings.mockRejectedValueOnce({type: 'NEW_PASSWORD_BAD'}).mockResolvedValueOnce(true);
    mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    const fill = (label: string, value: string) => {
      const input = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    };
    fill('Username', USERNAME);
    fill('Display name', 'Alice Example');
    fill('Password', 'StrongPassword123');
    fill('Confirm password', 'StrongPassword123');
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('Choose a stronger password.'));

    expect(mocks.setUser).not.toHaveBeenCalled();
    expect(mocks.toIm).not.toHaveBeenCalled();
    expect(document.querySelector('input[aria-label="Password"]')).not.toBeNull();

    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.toIm).toHaveBeenCalledOnce());
    expect(mocks.invokeApi).toHaveBeenCalledTimes(3);
    expect(mocks.updatePasswordSettings).toHaveBeenCalledTimes(2);
    expect(mocks.setUser).toHaveBeenCalledWith(user);
  });
});
