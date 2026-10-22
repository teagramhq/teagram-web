import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';
import TwoStepVerification from '@components/sidebarLeft/tabs/2fa';
import TwoStepVerificationHint from '@components/sidebarLeft/tabs/2fa/hint';

const mocks = vi.hoisted(() => ({
  tab: undefined as any,
  inputField: undefined as any,
  updateSettings: vi.fn(),
  createTab: vi.fn(),
  openTab: vi.fn(),
  sliceTabsUntilTab: vi.fn(),
  close: vi.fn(),
  createPopup: vi.fn(),
  popupOptions: undefined as any,
  showPopup: vi.fn(),
  toastNew: vi.fn()
}));

vi.mock('@components/solidJsTabs/superTabProvider', () => ({
  useSuperTab: () => [mocks.tab]
}));

vi.mock('@components/solidJsTabs', () => ({
  AppSettingsTab: class AppSettingsTab {}
}));

vi.mock('@components/solidJsTabs/tabs', () => ({
  AppTwoStepVerificationEmailTab: class AppTwoStepVerificationEmailTab {},
  AppTwoStepVerificationEnterPasswordTab: class AppTwoStepVerificationEnterPasswordTab {},
  AppTwoStepVerificationSetTab: class AppTwoStepVerificationSetTab {}
}));

vi.mock('@components/buttonTsx', () => ({
  default: (props: any) => {
    const labels: Record<string, string> = {
      'TwoStepAuth.SetupEmail': 'Set Recovery Email',
      'TwoStepAuth.ChangeEmail': 'Change Recovery Email',
      'Teagram.TwoStep.SkipHint': 'Skip'
    };

    return (
      <button
        class={props.class}
        disabled={props.disabled}
        ref={(element) => props.ref?.(element)}
        onClick={props.onClick}
      >
        {labels[props.text] ?? props.text ?? props.children}
      </button>
    );
  }
}));

vi.mock('@components/section', () => ({
  default: (props: any) => <section>{props.children}</section>
}));

vi.mock('@components/wrappers/stickerEmoji', () => ({default: vi.fn()}));
vi.mock('@components/inputField', () => ({default: class InputField {}}));
vi.mock('@components/inputFieldTsx', () => ({
  InputFieldTsx: (props: any) => {
    const field = {
      value: '',
      input: undefined as unknown as HTMLInputElement
    };
    mocks.inputField = field;
    props.instanceRef(field);

    return <input
      aria-label="Password hint"
      ref={(element) => field.input = element}
      onInput={(event) => field.value = event.currentTarget.value}
    />;
  }
}));
vi.mock('@components/popups', () => ({
  default: {
    createPopup: (_PopupPeer: unknown, _className: string, options: unknown) => {
      mocks.createPopup(_PopupPeer, _className, options);
      mocks.popupOptions = options;
      return {show: mocks.showPopup};
    }
  }
}));
vi.mock('@components/popups/peer', () => ({default: class PopupPeer {}}));
vi.mock('@components/putPreloader', () => ({putPreloader: vi.fn(() => ({remove: vi.fn()}))}));
vi.mock('@components/toast', () => ({toastNew: mocks.toastNew}));
vi.mock('@helpers/dom/cancelEvent', () => ({default: vi.fn()}));

import {AppTwoStepVerificationEnterPasswordTab, AppTwoStepVerificationSetTab} from '@components/solidJsTabs/tabs';

let dispose: VoidFunction;

function setupTab(payload: Record<string, unknown>) {
  const container = document.createElement('div');
  mocks.tab = {
    container: document.createElement('div'),
    payload,
    managers: {passwordManager: {updateSettings: mocks.updateSettings}},
    slider: {
      createTab: (...args: unknown[]) => {
        mocks.createTab(...args);
        return {open: mocks.openTab};
      },
      sliceTabsUntilTab: mocks.sliceTabsUntilTab
    },
    close: mocks.close
  };
  document.body.append(container);
  return container;
}

function mountHint(payload: Record<string, unknown>) {
  const container = setupTab(payload);
  dispose = render(() => <TwoStepVerificationHint />, container);
  return container;
}

function mountSettings(state: Record<string, unknown>, plainPassword: string) {
  const container = setupTab({state, plainPassword});
  dispose = render(() => <TwoStepVerification />, container);
  return container;
}

beforeEach(() => {
  mocks.updateSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset();
  mocks.openTab.mockReset();
  mocks.sliceTabsUntilTab.mockReset();
  mocks.close.mockReset();
  mocks.createPopup.mockReset();
  mocks.popupOptions = undefined;
  mocks.showPopup.mockReset();
  mocks.toastNew.mockReset();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

describe('two-step password settings', () => {
  it('saves a new password after the hint without opening a recovery-email step', async() => {
    const state = {pFlags: {has_password: false}};
    const container = mountHint({state, newPassword: 'new-password'});
    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'tea hint';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    (Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Continue') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce());

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      hint: 'tea hint',
      currentPassword: undefined,
      newPassword: 'new-password'
    });
    expect(mocks.updateSettings.mock.calls[0][0]).not.toHaveProperty('email');
    expect(mocks.createTab).toHaveBeenCalledWith(AppTwoStepVerificationSetTab);
    expect(mocks.openTab).toHaveBeenCalledWith({messageFor: 'password'});
    expect(container.textContent).not.toContain('RecoveryEmail');
  });

  it('saves a changed password without clearing its existing recovery email', async() => {
    const state = {pFlags: {has_password: true, has_recovery: true}};
    const container = mountHint({state, plainPassword: 'old-password', newPassword: 'new-password'});
    (Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Skip') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce());

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      hint: undefined,
      currentPassword: 'old-password',
      newPassword: 'new-password'
    });
    expect(mocks.updateSettings.mock.calls[0][0]).not.toHaveProperty('email');
    expect(mocks.createTab).toHaveBeenCalledWith(AppTwoStepVerificationSetTab);
  });

  it('ignores repeated Enter while the password update is pending', async() => {
    let resolveUpdate!: () => void;
    mocks.updateSettings.mockReturnValue(new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    }));

    const container = mountHint({newPassword: 'new-password'});
    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'tea hint';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new KeyboardEvent('keypress', {key: 'Enter', bubbles: true}));
    input.dispatchEvent(new KeyboardEvent('keypress', {key: 'Enter', bubbles: true}));

    expect(mocks.updateSettings).toHaveBeenCalledOnce();
    expect(mocks.createTab).not.toHaveBeenCalled();

    resolveUpdate();
    await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalledOnce());
    expect(mocks.openTab).toHaveBeenCalledWith({messageFor: 'password'});
  });

  it('keeps password change and removal while hiding recovery-email settings', async() => {
    const state = {pFlags: {has_password: true, has_recovery: true}};
    const container = mountSettings(state, 'current-password');
    const buttons = Array.from(container.querySelectorAll('button'));

    expect(container.textContent).toContain('TwoStepAuth.ChangePassword');
    expect(container.textContent).toContain('TwoStepAuth.RemovePassword');
    expect(container.textContent).not.toContain('Set Recovery Email');
    expect(container.textContent).not.toContain('Change Recovery Email');

    buttons.find((button) => button.textContent === 'TwoStepAuth.ChangePassword')?.click();
    expect(mocks.createTab).toHaveBeenCalledWith(AppTwoStepVerificationEnterPasswordTab);
    expect(mocks.openTab).toHaveBeenCalledWith({state, plainPassword: 'current-password'});

    buttons.find((button) => button.textContent === 'TwoStepAuth.RemovePassword')?.click();
    const removePassword = mocks.popupOptions.buttons[0].callback as () => void;
    removePassword();

    await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith({currentPassword: 'current-password'}));
    expect(mocks.sliceTabsUntilTab).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
