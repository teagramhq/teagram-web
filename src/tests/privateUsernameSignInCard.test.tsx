import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';

const mocks = vi.hoisted(() => ({
  invokeApi: vi.fn(),
  recoverUnknownAuthKey: vi.fn(),
  getAppConfig: vi.fn(),
  updatePasswordSettings: vi.fn(),
  setUser: vi.fn(),
  pushToState: vi.fn(),
  navigate: vi.fn(),
  toIm: vi.fn(),
  createGuest: vi.fn(),
  reauthenticateGuest: vi.fn(),
  guestLifecycleOptions: vi.fn(),
  toastNew: vi.fn()
}));

vi.mock('@/pages/authFlow', () => ({
  useAuthFlow: () => ({
    managers: {
      apiManager: {
        invokeApi: mocks.invokeApi,
        recoverUnknownAuthKey: mocks.recoverUnknownAuthKey,
        getAppConfig: mocks.getAppConfig,
        setUser: mocks.setUser
      },
      passwordManager: {updateSettings: mocks.updatePasswordSettings},
      appStateManager: {pushToState: mocks.pushToState}
    },
    navigate: mocks.navigate,
    toIm: mocks.toIm
  })
}));

vi.mock('@components/buttonTsx', () => ({
  default: (props: any) => (
    <button class={props.class} type={props.type} aria-label={props['aria-label']} disabled={props.disabled} onClick={props.onClick}>
      {props.children ?? props.text}
    </button>
  )
}));

vi.mock('@lib/guestAccountLifecycle', () => ({
  createCurrentGuestAccountLifecycle: (_managers: unknown, options: unknown) => {
    mocks.guestLifecycleOptions(options);
    return {create: mocks.createGuest, reauthenticate: mocks.reauthenticateGuest};
  }
}));

vi.mock('@components/mediaHeader', () => {
  const Header = (props: any) => <header>{props.children}</header>;
  Header.Sticker = (props: any) => <div>{props.element}</div>;
  Header.Title = (props: any) => <h1>{props.children}</h1>;
  Header.Subtitle = (props: any) => <p>{props.children}</p>;
  return {default: Header};
});

vi.mock('@components/languageChangeButton', () => ({default: (): null => null}));
vi.mock('@components/toast', () => ({toastNew: mocks.toastNew}));
vi.mock('@lib/langPack', async(importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/langPack')>();
  return {
    ...actual,
    i18n: (key: string, args?: unknown[]) => {
    const copy: Record<string, string> = {
      'Teagram.Registration.CreateAccount': 'Create account',
      'Teagram.Registration.SignIn': 'Sign in',
      'Teagram.Registration.Subtitle': 'Create your account',
      'Teagram.Registration.DisplayName': 'Display name',
      'Teagram.Registration.Password': 'Password',
      'Teagram.Registration.ConfirmPassword': 'Confirm password',
      'Teagram.Registration.InviteSecret': 'Invite secret',
      'Teagram.Registration.PasswordMismatch': 'Those passwords don\'t match.',
      'Teagram.Registration.UsernameHint': 'Use 2–32 characters, start with a letter, and use letters, numbers, or underscores.',
      'Teagram.Registration.UsernameTooShort': 'Use at least 2 characters.',
      'Teagram.Registration.UsernameTooLong': 'Use no more than 32 characters.',
      'Teagram.Registration.UsernameStart': 'Start with a letter.',
      'Teagram.Registration.UsernameCharacters': 'Use letters, numbers, and underscores only.',
      'Teagram.Registration.UsernameTaken': 'That username is taken.',
      'Teagram.Registration.InvalidUsername': 'Choose a valid username.',
      'Teagram.Registration.InvalidDisplayName': 'Enter a display name.',
      'Teagram.Registration.InvalidInvite': 'That invite secret is invalid.',
      'Teagram.Registration.InviteRequired': 'Enter an invite secret.',
      'Teagram.Registration.ConfirmPasswordRequired': 'Enter your password again.',
      'Teagram.Registration.PasswordMatch': 'Passwords match.',
      'Teagram.Registration.Closed': 'Account creation is closed on this server.',
      'Teagram.Registration.Network': 'Unable to create your account. Try again.',
      'Teagram.Registration.PasswordNetwork': 'Unable to set your password. Try again.',
      'Teagram.Registration.ConfigNetwork': 'Unable to check whether account creation is available.',
      'Teagram.Guest.Try': 'Try it as a guest',
      'Teagram.Guest.StartNew': 'Start a new guest',
      'Teagram.Demo.Banner.Title': 'Demo server: you\'re a guest.',
      'Teagram.Demo.Banner.Description': 'Everything is wiped every week. Use your own server at',
      'Teagram.Demo.ResetNotice': 'The demo was reset this week, so you have a new guest account.',
      'Teagram.Guest.Creating': 'Creating a guest account…',
      'Teagram.Guest.Disclosure': 'Your guest account is wiped weekly, is lost after you sign out or clear browser data, and is visible to the server operator.',
      'Teagram.Guest.Flood': 'Guest sign-up is temporarily limited for this network. Try again later.',
      'Teagram.Guest.FloodWait': 'Guest sign-up is temporarily limited for this network. Try again in %1$s.',
      'Teagram.Guest.RestoreFlood': 'Guest sign-in is temporarily limited for this network. Try again later.',
      'Teagram.Guest.RestoreFloodWait': 'Guest sign-in is temporarily limited for this network. Try again in %1$s.',
      'Teagram.Guest.RestoreNetwork': 'Unable to sign you back into your guest account. Check your connection and try again.',
      'Teagram.Guest.Unrecoverable': 'This guest account can\'t be recovered. Use a different account.',
      'Teagram.Guest.Network': 'Unable to create your guest account. Check your connection and try again.',
      'Teagram.Guest.AccountInUse': 'This account is already in use. Sign out before creating a guest account.',
      'Teagram.Guest.Collision': 'Guest sign-up couldn\'t find an available username. Try again.',
      'Teagram.Registration.SecurityCheckRetry': 'Try again',
      'Teagram.Registration.SecurityCheckFailed': 'The security check failed. Try again.',
      'Teagram.Registration.SecurityCheckExpired': 'The security check expired. Try again.',
      'Teagram.Registration.SecurityCheckUnavailable': 'The security check couldn\'t load. Try again.',
      'Teagram.Registration.SecurityCheckLoading': 'Loading security check…'
    };
    const span = document.createElement('span');
    span.textContent = (copy[key] || key).replace('%1$s', String(args?.[0] ?? ''));
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
  let turnstileCallbacks: {action: 'signin' | 'signup', callback: (token: string) => void, 'expired-callback': () => void};
  let turnstileReset: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.invokeApi.mockReset();
    mocks.recoverUnknownAuthKey.mockReset();
    mocks.getAppConfig.mockReset().mockResolvedValue({registration_mode: 'closed'});
    mocks.updatePasswordSettings.mockReset();
    mocks.setUser.mockReset();
    mocks.pushToState.mockReset();
    mocks.navigate.mockReset();
    mocks.toIm.mockReset();
    mocks.createGuest.mockReset().mockResolvedValue({kind: 'error', errorType: 'NETWORK_ERROR'});
    mocks.reauthenticateGuest.mockReset().mockResolvedValue({kind: 'noGuest'});
    mocks.guestLifecycleOptions.mockReset();
    mocks.toastNew.mockReset();
    delete (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__;
    (window as any).__TEAGRAM_ACTIVE_SERVER_HOST__ = 'demo.teagram.io';
    delete (window as any).__TEAGRAM_AUTO_GUEST__;
    delete (window as any).__TEAGRAM_ACTIVE_TURNSTILE_SITE_KEY__;
    localStorage.removeItem('teagram.auto-guest-attempted.v1');
    localStorage.removeItem('teagram.auto-guest-reset-notice.v1');
    turnstileCallbacks = undefined as any;
    turnstileReset = vi.fn();
    vi.stubGlobal('turnstile', {
      render: vi.fn((_container: HTMLElement, callbacks: {action: 'signin' | 'signup', callback: (token: string) => void, 'expired-callback': () => void}) => {
        turnstileCallbacks = callbacks;
        return 'test-widget';
      }),
      reset: turnstileReset,
      remove: vi.fn()
    });
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
    delete (window as any).__TEAGRAM_ACTIVE_SERVER_HOST__;
    storageWrites.forEach((spy) => spy.mockRestore());
    localStorage.removeItem('teagram.auto-guest-attempted.v1');
    localStorage.removeItem('teagram.auto-guest-reset-notice.v1');
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  function mount() {
    dispose = render(() => <PrivateSignInCard spec={{name: 'signIn'}}/>, document.body);
    return document.querySelector('input[aria-label="Username"]') as HTMLInputElement;
  }

  async function flushAuthFlow() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('rejects an empty username without an authentication call', () => {
    const input = mount();
    input.value = '';
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

  it('uses appConfig username rules for sign-in validation', async() => {
    mocks.getAppConfig.mockResolvedValue({
      registration_mode: 'closed',
      username_min_length: 2,
      username_max_length: 4,
      username_pattern: '^[a-z][a-z0-9_]{1,3}$'
    });
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'});
    const input = mount();
    await vi.waitFor(() => expect(mocks.getAppConfig).toHaveBeenCalledOnce());
    const next = document.querySelector('button') as HTMLButtonElement;
    const setUsername = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    };

    setUsername('a');
    expect(next.disabled).toBe(true);
    setUsername('1a');
    expect(next.disabled).toBe(true);
    setUsername('abcde');
    expect(next.disabled).toBe(true);
    setUsername('ab');
    expect(next.disabled).toBe(false);
    next.click();

    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({name: 'password'}));
    expect(mocks.invokeApi).toHaveBeenCalledWith('auth.sendCode', expect.objectContaining({phone_number: 'ab'}), {
      authKeyRecovery: true
    });
  });

  it('uses appConfig username rules and generic feedback while registering', async() => {
    mocks.getAppConfig.mockResolvedValue({
      registration_mode: 'open',
      username_min_length: 2,
      username_max_length: 4,
      username_pattern: '^a[a-z0-9_]{1,3}$'
    });
    const input = mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    const status = document.getElementById('registration-username-status');
    expect(status?.textContent).toBe('');

    input.value = 'a';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    expect(status?.textContent).toBe('Choose a valid username.');

    input.value = 'ab';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    expect(status?.textContent).toBe('');
    expect(input.getAttribute('aria-invalid')).not.toBe('true');

    input.value = 'a-b';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    expect(status?.textContent).toBe('Choose a valid username.');
  });

  it('shows the server username error when appConfig omits username rules', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockRejectedValueOnce({type: 'USERNAME_INVALID'});
    const input = mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    const fill = (label: string, value: string) => {
      const field = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new Event('input', {bubbles: true}));
    };
    fill('Username', 'a');
    fill('Display name', 'Alice Example');
    fill('Password', 'StrongPassword123');
    fill('Confirm password', 'StrongPassword123');
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('Choose a valid username.'));
    expect(mocks.invokeApi).toHaveBeenNthCalledWith(3, 'auth.signUp', expect.objectContaining({phone_number: 'a'}), {
      authKeyRecovery: true
    });
  });

  it('explains why Create is disabled while required registration fields are empty', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();
    const create = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement;

    expect(create.disabled).toBe(true);
    expect(document.getElementById('registration-username-status')?.textContent).toBe('');
    expect(document.getElementById('registration-display-name-status')?.textContent).toBe('Enter a display name.');
    expect(document.getElementById('registration-password-status')).toBeNull();
    expect(document.getElementById('registration-password-rules')).toBeNull();
    expect(document.getElementById('registration-confirm-password-status')?.textContent).toBe('Enter your password again.');
    expect(mocks.invokeApi).not.toHaveBeenCalled();
  });

  it('requires matching passwords without adding a client-side length or strength rule', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    const username = document.querySelector('input[aria-label="Username"]') as HTMLInputElement;
    const displayName = document.querySelector('input[aria-label="Display name"]') as HTMLInputElement;
    const password = document.querySelector('input[aria-label="Password"]') as HTMLInputElement;
    const confirmPassword = document.querySelector('input[aria-label="Confirm password"]') as HTMLInputElement;
    const create = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement;
    const setValue = (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    };

    expect(document.getElementById('registration-password-rules')).toBeNull();
    expect(document.getElementById('registration-password-status')).toBeNull();
    expect(document.getElementById('registration-confirm-password-status')?.textContent).toBe('Enter your password again.');

    setValue(username, 'adam');
    setValue(displayName, 'Alice Example');
    expect(document.getElementById('registration-password-rules')).toBeNull();
    expect(document.getElementById('registration-password-status')).toBeNull();
    setValue(password, 'x');
    expect(document.getElementById('registration-confirm-password-status')?.textContent).toBe('Enter your password again.');
    setValue(confirmPassword, 'y');
    expect(document.getElementById('registration-confirm-password-status')?.textContent).toBe('Those passwords don\'t match.');
    expect(create.disabled).toBe(true);

    setValue(confirmPassword, 'x');
    expect(document.getElementById('registration-confirm-password-status')?.textContent).toBe('Passwords match.');
    expect(create.disabled).toBe(false);
  });

  it('shows a taken username beside the username field after submit', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockRejectedValueOnce({type: 'USERNAME_OCCUPIED'});
    mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    const username = document.querySelector('input[aria-label="Username"]') as HTMLInputElement;
    const displayName = document.querySelector('input[aria-label="Display name"]') as HTMLInputElement;
    const password = document.querySelector('input[aria-label="Password"]') as HTMLInputElement;
    const confirmPassword = document.querySelector('input[aria-label="Confirm password"]') as HTMLInputElement;
    const setValue = (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    };
    setValue(username, USERNAME);
    setValue(displayName, 'Alice Example');
    setValue(password, 'x');
    setValue(confirmPassword, 'x');
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.getElementById('registration-username-status')?.textContent).toBe('That username is taken.'));
    expect(username.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn', 'auth.signUp']);
  });

  it('shows a reserved username rejection inline under the username field', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockRejectedValueOnce({type: 'USERNAME_INVALID'});
    mount();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Create account')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    const username = document.querySelector('input[aria-label="Username"]') as HTMLInputElement;
    const fill = (label: string, value: string) => {
      const input = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    };
    fill('Username', 'admin');
    fill('Display name', 'Alice Example');
    fill('Password', 'x');
    fill('Confirm password', 'x');
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Create account') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.getElementById('registration-username-status')?.textContent).toBe('Choose a valid username.'));
    expect(username.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn', 'auth.signUp']);
  });

  it.each([undefined, false, 'true', 1, null])('hides guest creation unless validated discovery is literal true (%s)', async(guestSignUp) => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'closed', demo: {guest_sign_up: true}});
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = guestSignUp;
    mount();
    await flushAuthFlow();

    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Try it as a guest')).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.invokeApi).not.toHaveBeenCalled();
  });

  it('creates a guest from the validated discovery and shows the recovery limits first', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'closed', demo: {guest_sign_up: false}});
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = true;
    (window as any).__TEAGRAM_ACTIVE_TURNSTILE_SITE_KEY__ = 'validated-site-key';
    let finishCreate!: (result: unknown) => void;
    mocks.createGuest.mockImplementationOnce(() => new Promise((resolve) => { finishCreate = resolve; }));

    mount();
    await flushAuthFlow();

    expect(document.body.textContent).toContain('Your guest account is wiped weekly, is lost after you sign out or clear browser data, and is visible to the server operator.');
    const guestButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Try it as a guest') as HTMLButtonElement;
    expect(guestButton).toBeDefined();
    guestButton.click();

    await vi.waitFor(() => expect(guestButton.disabled).toBe(true));
    expect(guestButton.textContent).toBe('Creating a guest account…');
    expect(mocks.guestLifecycleOptions).toHaveBeenCalledWith(expect.objectContaining({
      requestTurnstile: expect.any(Function),
      turnstileSiteKey: 'validated-site-key'
    }));
    finishCreate({kind: 'authorized', user: {_: 'user', id: 42}});
    await vi.waitFor(() => expect(mocks.toIm).toHaveBeenCalledOnce());
  });

  it('signs a returning guest in as soon as the auth card opens', async() => {
    mocks.reauthenticateGuest.mockResolvedValueOnce({kind: 'authorized', user: {_: 'user', id: 42}});

    mount();

    await vi.waitFor(() => expect(mocks.toIm).toHaveBeenCalledOnce());
    expect(mocks.createGuest).not.toHaveBeenCalled();
    expect(mocks.invokeApi).not.toHaveBeenCalled();
  });

  it('starts one guest sign-up automatically when auto-guest mode and discovery are enabled', async() => {
    (window as any).__TEAGRAM_AUTO_GUEST__ = true;
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = true;
    let disclosureVisibleWhenCreationStarts = false;
    mocks.createGuest.mockImplementationOnce(async() => {
      disclosureVisibleWhenCreationStarts = document.body.textContent?.includes(
        'Your guest account is wiped weekly, is lost after you sign out or clear browser data, and is visible to the server operator.'
      ) || false;
      return {kind: 'authorized', user: {_: 'user', id: 42}};
    });

    mount();

    await vi.waitFor(() => expect(mocks.createGuest).toHaveBeenCalledOnce());
    expect(disclosureVisibleWhenCreationStarts).toBe(true);
    await vi.waitFor(() => expect(mocks.toIm).toHaveBeenCalledOnce());
  });

  it('keeps the demo guest notice hidden when discovery does not allow guest sign-up', async() => {
    (window as any).__TEAGRAM_AUTO_GUEST__ = true;
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = false;

    mount();
    await flushAuthFlow();

    expect(document.body.textContent).not.toContain('Demo server: you\'re a guest.');
    expect(mocks.createGuest).not.toHaveBeenCalled();
  });

  it('restores a returning auto guest without starting another guest sign-up', async() => {
    (window as any).__TEAGRAM_AUTO_GUEST__ = true;
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = true;
    mocks.reauthenticateGuest.mockResolvedValueOnce({kind: 'authorized', user: {_: 'user', id: 42}});

    mount();

    await vi.waitFor(() => expect(mocks.toIm).toHaveBeenCalledOnce());
    expect(mocks.reauthenticateGuest).toHaveBeenCalledOnce();
    expect(mocks.createGuest).not.toHaveBeenCalled();
    expect(localStorage.getItem('teagram.auto-guest-attempted.v1')).toBe('1');
  });

  it('creates one replacement guest after a wipe and shows the reset notice after sign-in', async() => {
    (window as any).__TEAGRAM_AUTO_GUEST__ = true;
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = true;
    localStorage.setItem('teagram.auto-guest-attempted.v1', '1');
    mocks.reauthenticateGuest.mockResolvedValueOnce({kind: 'wiped'});
    mocks.createGuest.mockResolvedValueOnce({kind: 'authorized', user: {_: 'user', id: 42}});

    mount();

    await vi.waitFor(() => expect(mocks.createGuest).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.toIm).toHaveBeenCalledOnce());

    expect(mocks.toastNew).toHaveBeenCalledOnce();
    expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Teagram.Demo.ResetNotice'});
    expect(localStorage.getItem('teagram.auto-guest-attempted.v1')).toBe('1');
  });

  it('offers an explicit new-guest action after auto-guest was already attempted', async() => {
    (window as any).__TEAGRAM_AUTO_GUEST__ = true;
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = true;
    localStorage.setItem('teagram.auto-guest-attempted.v1', '1');

    mount();
    await flushAuthFlow();

    const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent === 'Start a new guest');
    expect(button).toBeDefined();
    expect(document.body.textContent).toContain('Demo server: you\'re a guest. Everything is wiped every week. Use your own server at web.teagram.io');
    expect(mocks.createGuest).not.toHaveBeenCalled();
  });

  it('shows the auto-sign-up error and a manual retry after automatic guest creation fails', async() => {
    (window as any).__TEAGRAM_AUTO_GUEST__ = true;
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = true;
    mocks.createGuest.mockResolvedValueOnce({kind: 'error', errorType: 'NETWORK_ERROR'});

    mount();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('Unable to create your guest account. Check your connection and try again.'));
    expect(document.body.textContent).toContain('Demo server: you\'re a guest. Everything is wiped every week. Use your own server at web.teagram.io');
    expect(document.body.textContent).toContain('Your guest account is wiped weekly, is lost after you sign out or clear browser data, and is visible to the server operator.');
    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Start a new guest')).toBe(true);
    expect(mocks.createGuest).toHaveBeenCalledOnce();
  });

  it('surfaces a saved-guest restore error without auto-creating a replacement', async() => {
    (window as any).__TEAGRAM_AUTO_GUEST__ = true;
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = true;
    mocks.reauthenticateGuest.mockResolvedValueOnce({kind: 'error', errorType: 'GUEST_LOCK_UNAVAILABLE'});

    mount();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('Unable to sign you back into your guest account. Check your connection and try again.'));
    expect(mocks.createGuest).not.toHaveBeenCalled();
  });

  it('reauthenticates an existing guest result before entering the app', async() => {
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = true;
    mocks.createGuest.mockResolvedValueOnce({kind: 'existing'});
    mocks.reauthenticateGuest
    .mockResolvedValueOnce({kind: 'noGuest'})
    .mockResolvedValueOnce({kind: 'authorized', user: {_: 'user', id: 42}});

    mount();
    await flushAuthFlow();
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Try it as a guest') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(mocks.toIm).toHaveBeenCalledOnce());
    expect(mocks.reauthenticateGuest).toHaveBeenCalledTimes(2);
    expect(mocks.createGuest).toHaveBeenCalledOnce();
  });

  it.each([
    [{kind: 'error', errorType: 'PHONE_NUMBER_FLOOD'}, 'Guest sign-up is temporarily limited for this network. Try again later.'],
    [{kind: 'error', errorType: 'FLOOD_WAIT_60'}, 'Try again in'],
    [{kind: 'unrecoverable', username: 'guest_aaaaaaaaaaaaaaaa'}, 'This guest account can\'t be recovered. Use a different account.'],
    [{kind: 'collisionsExhausted'}, 'Guest sign-up couldn\'t find an available username. Try again.'],
    [{kind: 'error', errorType: 'RECAPTCHA_CHECK_FAILED'}, 'The security check failed. Try again.'],
    [{kind: 'error', errorType: 'NETWORK_ERROR'}, 'Unable to create your guest account. Check your connection and try again.']
  ])('shows an actionable guest sign-up error for %s', async(result, expected) => {
    (window as any).__TEAGRAM_ACTIVE_GUEST_SIGN_UP__ = true;
    mocks.createGuest.mockResolvedValueOnce(result);
    mount();
    await flushAuthFlow();

    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Try it as a guest') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(expected));
    expect(mocks.createGuest).toHaveBeenCalledOnce();
    expect(mocks.toIm).not.toHaveBeenCalled();
  });

  it('sends the username with an empty code and enters the existing password card', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'closed', turnstile: {site_key: 'signup-only-site-key'}});
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'});
    const input = mount();
    const next = document.querySelector('button') as HTMLButtonElement;
    input.value = USERNAME;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    next.click();
    await flushAuthFlow();

    expect(mocks.invokeApi).toHaveBeenNthCalledWith(1, 'auth.sendCode', expect.objectContaining({phone_number: USERNAME}), {
      authKeyRecovery: true
    });
    expect(mocks.invokeApi).toHaveBeenNthCalledWith(2, 'auth.signIn', {
      phone_number: USERNAME,
      phone_code_hash: 'mock-code-hash',
      phone_code: ''
    }, {ignoreErrors: true, authKeyRecovery: true});
    expect(mocks.navigate).toHaveBeenCalledWith({name: 'password'});
    expect(isPrivateUsernameLogin()).toBe(true);
    expect(input.value).toBe('');
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    expect(document.querySelector('[data-testid="turnstile-challenge"]')).toBeNull();
    expect(mocks.invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
    expect(mocks.pushToState.mock.calls).toEqual([['authState', {_: 'authStateSignIn'}]]);
    const hasStoredUsername = storageWrites.some((spy) =>
      spy.mock.calls.some((call: unknown[]) => call.some((value: unknown) => String(value).includes(USERNAME)))
    );
    expect(hasStoredUsername).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each(['AUTH_KEY_UNKNOWN', 'AUTH_KEY_RATE_LIMIT'])('shows a retryable sign-in error and re-enables submit after %s', async(type) => {
    let rejectRequest!: (error: unknown) => void;
    mocks.invokeApi.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    const input = mount();
    const next = document.querySelector('button') as HTMLButtonElement;
    input.value = USERNAME;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    next.click();

    await vi.waitFor(() => {
      expect(next.disabled).toBe(true);
      expect(next.textContent).toBe('Please wait…');
    });

    rejectRequest({code: type === 'AUTH_KEY_UNKNOWN' ? -404 : -429, type});
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('Unable to sign in. Try again.'));

    expect(input.value).toBe(USERNAME);
    expect(next.disabled).toBe(false);
    expect(next.textContent).toBe('Next');
    expect(mocks.invokeApi).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();

    next.click();
    await vi.waitFor(() => expect(mocks.invokeApi).toHaveBeenCalledTimes(2));
  });

  it('preserves the username when auth-key recovery exchange fails', async() => {
    mocks.invokeApi.mockRejectedValueOnce({code: -404, type: 'AUTH_KEY_UNKNOWN', authKeyRecoveryId: 17});
    mocks.recoverUnknownAuthKey.mockRejectedValueOnce({code: -500, type: 'MTPROTO_TRANSPORT_ERROR'});
    const input = mount();
    const next = document.querySelector('button') as HTMLButtonElement;
    input.value = USERNAME;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    next.click();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('Unable to sign in. Try again.'));

    expect(mocks.recoverUnknownAuthKey).toHaveBeenCalledWith(17, true);
    expect(input.value).toBe(USERNAME);
    expect(next.disabled).toBe(false);
    expect(next.textContent).toBe('Next');
  });

  it('protects username sign-in with the signin Turnstile action', async() => {
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'closed', turnstile: {site_key: 'test-site-key'}});
    mocks.invokeApi
    .mockRejectedValueOnce({type: 'RECAPTCHA_CHECK_signin__test-site-key'})
    .mockResolvedValueOnce(SENT_CODE)
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'});
    const input = mount();
    await flushAuthFlow();
    input.value = USERNAME;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    (document.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.querySelector('[data-testid="turnstile-challenge"]')).not.toBeNull());
    expect(turnstileCallbacks.action).toBe('signin');
    turnstileCallbacks.callback('signin-token');
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({name: 'password'}));

    expect(mocks.invokeApi).toHaveBeenNthCalledWith(1, 'auth.sendCode', expect.objectContaining({phone_number: USERNAME}), {
      authKeyRecovery: true
    });
    expect(mocks.invokeApi).toHaveBeenNthCalledWith(2, 'invokeWithReCaptcha', expect.objectContaining({
      token: 'signin-token',
      query: expect.objectContaining({_: 'auth.sendCode', phone_number: USERNAME})
    }), {authKeyRecovery: true});
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

    const inviteSecret = document.querySelector('input[aria-label="Invite secret"]') as HTMLInputElement;
    expect(inviteSecret).not.toBeNull();
    expect(inviteSecret.getAttribute('aria-describedby')).toBe('registration-invite-secret-status');
    expect(document.getElementById('registration-invite-secret-status')?.textContent).toBe('Enter an invite secret.');
  });

  it('keeps registration fields and allows a retry after an expired or rejected Turnstile token', async() => {
    const user = {_: 'user', id: 44};
    mocks.getAppConfig.mockResolvedValue({registration_mode: 'open'});
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockResolvedValueOnce({_: 'auth.authorizationSignUpRequired', terms_of_service: {}})
    .mockRejectedValueOnce({type: 'RECAPTCHA_CHECK_signup__test-site-key'})
    .mockRejectedValueOnce({type: 'RECAPTCHA_CHECK_signup__test-site-key'})
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

    await vi.waitFor(() => expect(document.querySelector('[data-testid="turnstile-challenge"]')).not.toBeNull());
    expect(turnstileCallbacks.action).toBe('signup');
    expect((document.querySelector('input[aria-label="Display name"]') as HTMLInputElement).value).toBe('Alice Example');
    expect((document.querySelector('[data-testid="turnstile-challenge"]') as HTMLElement).dataset.sitekey).toBe('test-site-key');

    turnstileCallbacks['expired-callback']();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Try again')).toBe(true));
    expect((document.querySelector('input[aria-label="Display name"]') as HTMLInputElement).value).toBe('Alice Example');

    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Try again') as HTMLButtonElement).click();
    expect(turnstileReset).toHaveBeenCalledWith('test-widget');
    turnstileCallbacks.callback('rejected-token');
    await vi.waitFor(() => expect(mocks.invokeApi).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Try again')).toBe(true));
    (Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Try again') as HTMLButtonElement).click();
    turnstileCallbacks.callback('fresh-token');
    await vi.waitFor(() => expect(mocks.toIm).toHaveBeenCalledOnce());

    expect(mocks.invokeApi).toHaveBeenNthCalledWith(4, 'invokeWithReCaptcha', expect.objectContaining({token: 'rejected-token'}), {
      authKeyRecovery: true
    });
    expect(mocks.invokeApi).toHaveBeenNthCalledWith(5, 'invokeWithReCaptcha', expect.objectContaining({token: 'fresh-token'}), {
      authKeyRecovery: true
    });
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
    expect(mocks.invokeApi).toHaveBeenNthCalledWith(4, 'auth.sendCode', expect.objectContaining({phone_number: USERNAME}), {
      authKeyRecovery: true
    });
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

  it('keeps a provisional account in the registration form when password verifier setup fails and lets the user retry', async() => {
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
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('Unable to set your password. Try again.'));

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
