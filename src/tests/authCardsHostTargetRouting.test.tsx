import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';

const mocks = vi.hoisted(() => ({
  privateTarget: false,
  currentAccount: 1,
  invokeApi: vi.fn(),
  setUser: vi.fn(),
  pushToState: vi.fn(),
  getPasswordState: vi.fn(),
  checkPassword: vi.fn(),
  requestRecovery: vi.fn(),
  deleteAccount: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  sessionGet: vi.fn(),
  sessionSet: vi.fn(),
  sessionDelete: vi.fn(),
  navigateQrToSignIn: vi.fn(),
  navigateCard: vi.fn(),
  bootstrapIm: vi.fn()
}));

vi.mock('@config/mtprotoTarget', () => ({
  isPrivateMtprotoTarget: () => mocks.privateTarget
}));

vi.mock('@config/app', () => ({default: {id: 1, hash: 'test'}}));

vi.mock('@components/scrollable2', () => ({
  default: (props: any) => <div class={props.class}>{props.children}</div>
}));

vi.mock('@components/buttonTsx', () => {
  const Button = (props: any) => (
    <button class={props.class} disabled={props.disabled} onClick={props.onClick}>
      {props.children ?? props.text}
    </button>
  );
  Button.Icon = (props: any) => (
    <button aria-label={props.icon} class={props.class} onClick={props.onClick}>
      {props.icon}
    </button>
  );
  return {default: Button};
});

vi.mock('@components/inputField', () => ({
  default: class {
    container = document.createElement('div');
    input = document.createElement('input');

    constructor(options: {labelText: string}) {
      this.input.type = 'text';
      this.input.setAttribute('aria-label', options.labelText);
      this.container.append(this.input);
    }

    get value() {
      return this.input.value;
    }

    setValueSilently(value: string) {
      this.input.value = value;
    }
  }
}));

vi.mock('@components/languageChangeButton', () => ({default: (): null => null}));

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

vi.mock('@components/popups/simpleConfirmation', () => ({SimpleConfirmationPopup: {show: vi.fn()}}));
vi.mock('@components/toast', () => ({toastNew: vi.fn()}));
vi.mock('@components/wrappers/wrapDuration', () => ({wrapFormattedDuration: vi.fn()}));
vi.mock('@environment/touchSupport', () => ({default: true}));
vi.mock('@environment/userAgent', () => ({IS_MOBILE_SAFARI: false}));
vi.mock('@helpers/dom/anchorCallback', () => ({default: vi.fn(() => document.createElement('a'))}));
vi.mock('@helpers/dom/cancelEvent', () => ({default: (event?: Event) => event?.preventDefault()}));
vi.mock('@helpers/dom/focusWhenConnected', () => ({default: vi.fn(() => () => {})}));
vi.mock('@helpers/dom/htmlToSpan', () => ({default: vi.fn(() => document.createElement('span'))}));
vi.mock('@helpers/dom/loadFonts', () => ({default: vi.fn(() => Promise.resolve())}));
vi.mock('@helpers/dom/replaceContent', () => ({default: vi.fn()}));
vi.mock('@helpers/formatDuration', () => ({default: vi.fn()}));
vi.mock('@helpers/mediaSizes', () => ({default: {isMobile: false}}));
vi.mock('@helpers/schedulers', () => ({doubleRaf: vi.fn(() => Promise.resolve())}));
vi.mock('@helpers/schedulers/pause', () => ({default: vi.fn(() => Promise.resolve())}));
vi.mock('@helpers/string/classNames', () => ({
  default: (...values: Array<string | undefined | false>) => values.filter(Boolean).join(' ')
}));
vi.mock('@helpers/themeController', () => ({default: {switchTheme: vi.fn()}}));
vi.mock('@lib/accounts/changeAccount', () => ({changeAccount: vi.fn()}));
vi.mock('@lib/accounts/getCurrentAccount', () => ({getCurrentAccount: () => mocks.currentAccount}));
vi.mock('@lib/accounts/getValidatedAccount', () => ({getValidatedAccount: (value: number) => value}));
vi.mock('@lib/langPack', () => ({
  i18n: (key: string) => {
    const element = document.createElement('span');
    element.textContent = key;
    return element;
  }
}));
vi.mock('@lib/richTextProcessor/wrapEmojiText', () => ({default: vi.fn()}));
vi.mock('@lib/rootScope', () => ({
  default: {
    managers: {
      apiManager: {invokeApi: mocks.invokeApi, setUser: mocks.setUser},
      appStateManager: {pushToState: mocks.pushToState},
      passwordManager: {
        getState: mocks.getPasswordState,
        check: mocks.checkPassword,
        requestRecovery: mocks.requestRecovery
      },
      appAccountManager: {deleteAccount: mocks.deleteAccount}
    },
    addEventListener: mocks.addEventListener,
    removeEventListener: mocks.removeEventListener
  }
}));
vi.mock('@lib/sessionStorage', () => ({
  default: {get: mocks.sessionGet, set: mocks.sessionSet, delete: mocks.sessionDelete}
}));
vi.mock('@vendor/solid-transition-group', async() => {
  const {children} = await import('solid-js');
  return {
    Transition: (props: any) => {
      const child = children(() => props.children);
      return <>{child()}</>;
    }
  };
});

vi.mock('@/pages/AuthCard', () => ({
  default: (props: any) => <section class={props.class}>{props.header}{props.children}</section>
}));
vi.mock('@/pages/authFlow', async() => {
  const {createContext, createSignal, useContext} = await import('solid-js');
  const [currentCard, setCurrentCard] = createSignal<any>(null);
  const AuthFlowContext = createContext<any>();
  return {
    AuthFlowContext,
    currentCard,
    matchCard: (name: string) => currentCard()?.name === name ? currentCard() : null,
    navigateAuth: (spec: any) => {
      mocks.navigateCard(spec);
      setCurrentCard(spec);
    },
    useAuthFlow: () => useContext(AuthFlowContext)
  };
});
vi.mock('@/pages/authFlow.module.scss', () => ({
  default: {
    host: 'host',
    hostExit: 'host-exit',
    hostExiting: 'host-exiting',
    hostEnter: 'host-enter',
    hostEntering: 'host-entering',
    leaving: 'leaving',
    closeButton: 'close-button',
    themeButton: 'theme-button',
    scrollable: 'scrollable',
    placeholder: 'placeholder',
    placeholderTop: 'placeholder-top',
    cardsContainer: 'cards-container',
    cardEnterActive: 'card-enter-active',
    cardExitActive: 'card-exit-active',
    cardEnter: 'card-enter',
    cardEnterTo: 'card-enter-to',
    cardExit: 'card-exit',
    cardExitTo: 'card-exit-to',
    pageSignIn: 'page-sign-in',
    logoContainer: 'logo-container',
    logo: 'logo',
    pagePassword: 'page-password',
    errorLabel: 'error-label',
    forgotLink: 'forgot-link'
  }
}));
vi.mock('@/pages/bootstrapIm', () => ({bootstrapIm: mocks.bootstrapIm}));
vi.mock('@/pages/cards/SignInCard', () => ({
  default: () => <div data-card="official-signIn"/>
}));
vi.mock('@/pages/cards/AuthCodeCard', () => ({
  default: () => <div data-card="official-authCode"/>
}));
vi.mock('@/pages/cards/PasswordCard', () => ({
  default: () => <div data-card="official-password"/>
}));
vi.mock('@/pages/cards/SignUpCard', () => ({
  default: () => <div data-card="official-signUp"/>
}));
vi.mock('@/pages/cards/EmailRecoverCard', () => ({
  default: () => <div data-card="emailRecover"/>
}));
vi.mock('@/pages/cards/SignQRCard', () => ({
  default: () => mocks.privateTarget ?
    <button onClick={mocks.navigateQrToSignIn}>Sign in with username</button> :
    <div data-card="official-signQR"/>
}));
vi.mock('@/pages/cards/SignImportCard', () => ({
  default: () => <div data-card="signImport"/>
}));
const SENT_CODE = {
  _: 'auth.sentCode',
  phone_code_hash: 'mock-code-hash',
  type: {_ : 'auth.sentCodeTypeApp', length: 5},
  timeout: 60
};

const USERNAME = 'Alice_123';
const AUTH_CODE = {
  _: 'auth.sentCode',
  phone_code_hash: 'mock-code-hash',
  type: {_ : 'auth.sentCodeTypeApp', length: 5},
  timeout: 60
} as const;
const SIGN_UP = {phone_number: '+12025550123', phone_code_hash: 'mock-code-hash'} as const;

type CardSpec = import('@/pages/authFlow').CardSpec;

describe('AuthCardsHost target-specific routing', () => {
  let dispose: VoidFunction;
  let consoleSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    mocks.privateTarget = false;
    mocks.currentAccount = 1;
    mocks.invokeApi.mockReset();
    mocks.setUser.mockReset();
    mocks.pushToState.mockReset();
    mocks.getPasswordState.mockReset().mockResolvedValue({hint: ''});
    mocks.checkPassword.mockReset().mockRejectedValue({type: 'PASSWORD_HASH_INVALID'});
    mocks.requestRecovery.mockReset().mockResolvedValue({email_pattern: 'a***@example.test'});
    mocks.deleteAccount.mockReset().mockResolvedValue(undefined);
    mocks.addEventListener.mockReset();
    mocks.removeEventListener.mockReset();
    mocks.sessionGet.mockReset().mockResolvedValue(undefined);
    mocks.sessionSet.mockReset().mockResolvedValue(undefined);
    mocks.sessionDelete.mockReset().mockResolvedValue(undefined);
    mocks.navigateQrToSignIn.mockReset();
    mocks.navigateCard.mockReset();
    mocks.bootstrapIm.mockReset();
    consoleSpies = [];
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    consoleSpies.forEach((spy) => spy.mockRestore());
    document.body.replaceChildren();
  });

  async function mount(privateTarget: boolean, spec: CardSpec, currentAccount = 1) {
    mocks.privateTarget = privateTarget;
    mocks.currentAccount = currentAccount;
    const authFlow = await import('@/pages/authFlow');
    const {default: AuthCardsHost} = privateTarget ?
      // @ts-expect-error Vite query IDs keep the module-level target isolated per build mode
      await import('@/pages/AuthCardsHost?private-target-test') :
      // @ts-expect-error Vite query IDs keep the module-level target isolated per build mode
      await import('@/pages/AuthCardsHost?official-target-test');
    mocks.navigateQrToSignIn.mockImplementation(() => authFlow.navigateAuth({name: 'signIn'}));
    authFlow.navigateAuth(spec);
    mocks.navigateCard.mockClear();
    dispose = render(() => <AuthCardsHost/>, document.body);
    return authFlow.navigateAuth;
  }

  async function waitForSelector(selector: string) {
    await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
  }

  async function waitForUsername() {
    await waitForSelector('input[aria-label="Username"]');
  }

  it('shows the username form from private sign-in without requesting a phone code', async() => {
    await mount(true, {name: 'signIn'}, 2);
    await waitForUsername();

    expect(document.querySelector('input[aria-label="Username"]')).not.toBeNull();
    expect(document.querySelector('input[type="tel"]')).toBeNull();
    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Next')).toBe(true);
    expect(document.querySelector('button[aria-label="back"]')).not.toBeNull();
    expect(mocks.invokeApi).not.toHaveBeenCalled();
  });

  it.each([
    ['authCode', {name: 'authCode', payload: AUTH_CODE} as CardSpec],
    ['signUp', {name: 'signUp', payload: SIGN_UP} as CardSpec]
  ])('replaces restored private %s state with the username form', async(_name, spec) => {
    await mount(true, spec);
    await waitForUsername();

    expect(document.querySelector('input[type="tel"]')).toBeNull();
    expect(mocks.invokeApi).not.toHaveBeenCalled();
  });

  it('routes username sign-in through the private password step and redacts credential errors', async() => {
    mocks.invokeApi
    .mockResolvedValueOnce(SENT_CODE)
    .mockRejectedValueOnce({type: 'SESSION_PASSWORD_NEEDED'});
    const rawPasswordError = {type: 'PASSWORD_HASH_INVALID', message: 'server rejected ' + USERNAME};
    mocks.checkPassword.mockRejectedValue(rawPasswordError);
    consoleSpies = ['debug', 'info', 'log', 'warn', 'error'].map((key) => vi.spyOn(console, key as any));
    await mount(true, {name: 'signIn'});
    await waitForUsername();

    const username = document.querySelector('input[aria-label="Username"]') as HTMLInputElement;
    username.value = USERNAME;
    username.dispatchEvent(new Event('input', {bubbles: true}));
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Next')!.click();
    await waitForSelector('input[aria-label="LoginPassword"]');

    expect(document.querySelector('[data-card="official-password"]')).toBeNull();
    expect(mocks.invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode', 'auth.signIn']);
    expect(mocks.navigateCard).toHaveBeenCalledWith({name: 'password'});

    const password = document.querySelector('input[aria-label="LoginPassword"]') as HTMLInputElement;
    password.value = 'mock-password';
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Login.Next')!.click();
    await waitForSelector('[role="alert"]');

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('invalid username or password');
    const attributes = Array.from(document.body.querySelectorAll('*'))
    .flatMap((element) => Array.from(element.attributes).map((attribute) => attribute.value))
    .join('\n');
    expect(document.body.innerHTML).not.toContain(USERNAME);
    expect(document.body.innerHTML).not.toContain(rawPasswordError.message);
    expect(attributes).not.toContain(USERNAME);
    expect(attributes).not.toContain(rawPasswordError.message);
    expect(location.href).not.toContain(USERNAME);
    const logs = JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls));
    expect(logs).not.toContain(USERNAME);
    expect(logs).not.toContain(rawPasswordError.message);
  });

  it('keeps pending username work from changing the host after navigating away', async() => {
    let resolveSendCode!: (value: typeof SENT_CODE) => void;
    mocks.invokeApi.mockReturnValueOnce(new Promise((resolve) => {
      resolveSendCode = resolve;
    }));
    const navigateAuth = await mount(true, {name: 'signIn'});
    await waitForUsername();

    const username = document.querySelector('input[aria-label="Username"]') as HTMLInputElement;
    username.value = USERNAME;
    username.dispatchEvent(new Event('input', {bubbles: true}));
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Next')!.click();
    navigateAuth({name: 'signQR'});
    await vi.waitFor(() => expect(document.body.textContent).toContain('Sign in with username'));
    mocks.navigateCard.mockClear();

    resolveSendCode(SENT_CODE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.invokeApi.mock.calls.map(([method]) => method)).toEqual(['auth.sendCode']);
    expect(mocks.navigateCard).not.toHaveBeenCalled();
    expect(mocks.setUser).not.toHaveBeenCalled();
    expect(mocks.bootstrapIm).not.toHaveBeenCalled();
    expect(document.querySelector('input[aria-label="Username"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain('Sign in with username');
  });

  it('uses the same username form for the private QR escape action', async() => {
    await mount(true, {name: 'signQR'});
    await vi.waitFor(() => expect(document.body.textContent).toContain('Sign in with username'));

    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Sign in with username')!.click();
    await waitForUsername();

    expect(document.querySelector('input[type="tel"]')).toBeNull();
    expect(mocks.navigateCard).toHaveBeenCalledWith({name: 'signIn'});
  });

  it('retains every official phone-sign-in card mapping', async() => {
    const cases: Array<[CardSpec, string]> = [
      [{name: 'signIn'}, '[data-card="official-signIn"]'],
      [{name: 'authCode', payload: AUTH_CODE}, '[data-card="official-authCode"]'],
      [{name: 'signUp', payload: SIGN_UP}, '[data-card="official-signUp"]'],
      [{name: 'password'}, '[data-card="official-password"]'],
      [{name: 'signQR'}, '[data-card="official-signQR"]']
    ];

    for(const [spec, selector] of cases) {
      await mount(false, spec);
      await waitForSelector(selector);
      expect(document.querySelector(selector)).not.toBeNull();
      dispose();
      dispose = undefined;
      document.body.replaceChildren();
    }
  });
});
