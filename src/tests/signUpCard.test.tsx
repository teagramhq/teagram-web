import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';

const mocks = vi.hoisted(() => ({
  getAppConfig: vi.fn(),
  invokeApi: vi.fn(),
  setUser: vi.fn(),
  pushToState: vi.fn(),
  toIm: vi.fn()
}));

vi.mock('@/pages/authFlow', () => ({
  useAuthFlow: () => ({
    managers: {
      apiManager: {
        getAppConfig: mocks.getAppConfig,
        invokeApi: mocks.invokeApi,
        setUser: mocks.setUser
      },
      appStateManager: {pushToState: mocks.pushToState}
    },
    toIm: mocks.toIm
  })
}));

vi.mock('@components/buttonTsx', () => ({
  default: (props: any) => <button disabled={props.disabled} onClick={props.onClick}>{props.children}</button>
}));
vi.mock('@components/icon', () => ({default: () => document.createElement('span')}));
vi.mock('@components/popups', () => ({default: {createPopup: vi.fn()}}));
vi.mock('@components/popups/avatar', () => ({default: {}}));
vi.mock('@lib/customEmoji/renderer', () => ({CustomEmojiRendererElement: {create: vi.fn()}}));
vi.mock('@lib/richTextProcessor/wrapRichText', () => ({
  createCustomFiller: vi.fn(),
  insertCustomFillers: vi.fn(),
  default: vi.fn()
}));
vi.mock('@components/mediaHeader', () => {
  const Header = (props: any) => <header>{props.children}</header>;
  Header.Sticker = (props: any) => <div>{props.element}</div>;
  Header.Title = (props: any) => <h1>{props.children}</h1>;
  Header.Subtitle = (props: any) => <p>{props.children}</p>;
  return {default: Header};
});
vi.mock('@/pages/AuthCard', () => ({default: (props: any) => <section>{props.header}{props.children}</section>}));
vi.mock('@/pages/TurnstileChallenge', () => ({
  default: (): null => null,
  useTurnstileChallenge: (): {
    challenge: () => undefined,
    request: ReturnType<typeof vi.fn>,
    cancel: ReturnType<typeof vi.fn>
  } => ({challenge: () => undefined, request: vi.fn(), cancel: vi.fn()})
}));
vi.mock('@/pages/authFlow.module.scss', () => ({default: {pageSignUp: 'page-sign-up'}}));

import SignUpCard from '@/pages/cards/SignUpCard';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

describe('sign-up card', () => {
  let dispose: VoidFunction;

  beforeEach(() => {
    mocks.getAppConfig.mockReset();
    mocks.invokeApi.mockReset();
    mocks.setUser.mockReset().mockResolvedValue(undefined);
    mocks.pushToState.mockReset();
    mocks.toIm.mockReset();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
  });

  it('disables submit while appConfig is pending and sends signup only once', async() => {
    const appConfig = deferred<{display_name_max_length: number}>();
    const authResponse = deferred<unknown>();
    mocks.getAppConfig.mockReturnValue(appConfig.promise);
    mocks.invokeApi.mockReturnValue(authResponse.promise);

    dispose = render(() => <SignUpCard spec={{
      name: 'signUp',
      payload: {phone_number: '+12025550123', phone_code_hash: 'mock-code-hash'}
    }}/>, document.body);

    const firstName = document.querySelectorAll<HTMLElement>('.input-field-input')[0];
    const submit = document.querySelector('button') as HTMLButtonElement;
    firstName.textContent = 'Ada';

    submit.click();
    expect(submit.disabled).toBe(true);
    submit.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));

    appConfig.resolve({display_name_max_length: 64});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.invokeApi).toHaveBeenCalledTimes(1);
    expect(mocks.invokeApi).toHaveBeenCalledWith('auth.signUp', expect.objectContaining({first_name: 'Ada'}));

    authResponse.resolve({_: 'auth.authorizationSignUpRequired'});
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
  });
});
