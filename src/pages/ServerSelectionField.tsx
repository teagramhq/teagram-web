import {createSignal, JSX, onCleanup, onMount, Show} from 'solid-js';

import Button from '@components/buttonTsx';
import InputField from '@components/inputField';
import {getServerSelectionAction} from '@config/serverSelection';
import type {ServerSelectionState} from '@config/serverSelection';
import IS_TOUCH_SUPPORTED from '@environment/touchSupport';
import {i18n} from '@lib/langPack';
import type {LangPackKey} from '@lib/langPack';

import styles from '@/pages/authFlow.module.scss';

export default function ServerSelectionField(props: {
  readOnly?: boolean,
  children?: JSX.Element,
  continueLabel?: string,
  canContinue?: () => boolean,
  onContinue?: () => void | Promise<void>,
  beforeChange?: () => void,
  beforeCancelChange?: () => void,
  pendingActions?: JSX.Element
}) {
  const action = getServerSelectionAction();
  if(!action) return props.children;

  const field = new InputField({
    label: 'Teagram.Server.Address',
    placeholder: 'Teagram.Server.Placeholder',
    maxLength: 253,
    plainText: true,
    autocomplete: 'off'
  });
  const input = field.input as HTMLInputElement;
  input.id = 'server-address';
  input.setAttribute('aria-label', i18n('Teagram.Server.Address').textContent || 'Server address');
  input.autocapitalize = 'none';
  input.autocomplete = 'off';
  input.inputMode = 'url';
  input.spellcheck = false;
  input.dir = 'ltr';
  field.setValueSilently(action.getState().host);

  const [state, setState] = createSignal<ServerSelectionState>(action.getState());
  let abortController: AbortController | undefined;

  const message = (current: ServerSelectionState) => current.errorKey ?
    i18n(current.errorKey as LangPackKey, current.errorKey === 'Teagram.Server.WebSocketFailed' ? [location.origin] : undefined) : undefined;
  const connected = () => state().phase === 'connected';
  const changing = () => !!state().changing;
  const isProgress = () => state().phase === 'checking' || state().phase === 'connecting';
  const isLocked = () => !!state().locked || state().phase === 'connecting' || props.readOnly;
  const submitLabel = () => state().phase === 'connecting' ? i18n('Teagram.Server.Connecting') :
    state().phase === 'checking' ? i18n('Teagram.Server.Checking') :
      state().retryable ? i18n('Teagram.Server.TryAgain') : props.continueLabel || i18n('Teagram.Server.Continue');

  function sync(current: ServerSelectionState) {
    const wasChanging = !!state().changing;
    setState(current);
    if(input.value !== current.host && (current.phase === 'connected' || !current.changing)) {
      field.setValueSilently(current.host);
    }
    input.readOnly = connected() && !changing() || isLocked();
    input.title = current.host;
    input.classList.toggle('error', !!current.errorKey);
    if(current.errorKey) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'server-selection-error');
    } else {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
    if(current.changing && !wasChanging) requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  const unsubscribe = action.subscribe(sync);
  sync(action.getState());

  function handleInput() {
    abortController?.abort();
    abortController = undefined;
    input.classList.remove('error');
    input.removeAttribute('aria-invalid');
    action.setHost(input.value);
  }

  async function useServer() {
    if(isProgress() || isLocked()) return;
    if(props.onContinue) {
      await props.onContinue();
      return;
    }
    abortController?.abort();
    abortController = new AbortController();
    try {
      if(state().errorKey === 'Teagram.Server.KeyMismatch') action.continueBlocked();
      else await action.select(input.value, abortController.signal, input);
    } finally {
      abortController = undefined;
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if(event.key === 'Escape' && changing()) {
      event.preventDefault();
      abortController?.abort();
      action.cancelChange();
    } else if(event.key === 'Enter' && !input.readOnly && !isProgress()) {
      event.preventDefault();
      void useServer();
    }
  };

  input.addEventListener('input', handleInput);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('click', () => {
    if(connected() && !changing() && !props.readOnly) action.change();
  });
  const onCancelChange = () => {
    abortController?.abort();
    props.beforeCancelChange?.();
    action.cancelChange();
  };
  onMount(() => {
    if(!IS_TOUCH_SUPPORTED && state().phase !== 'connected') input.focus();
  });
  onCleanup(() => {
    abortController?.abort();
    unsubscribe();
    input.removeEventListener('input', handleInput);
    input.removeEventListener('keydown', onKeyDown);
    field.setValueSilently('');
  });

  return (
    <div class={styles.serverSelection}>
      <div class={connected() ? styles.serverSelectionReadOnly : styles.serverSelectionHostRow}>
        {field.container}
        <Show when={connected() && !props.readOnly}>
          <button
            class={styles.serverSelectionChange}
            type="button"
            aria-label={i18n('Teagram.Server.ChangeA11y').textContent || 'Change server'}
            aria-describedby="server-address"
            onClick={() => {
              props.beforeChange?.();
              action.change();
            }}
          >
            {i18n('Teagram.Server.Change')}
          </button>
        </Show>
      </div>
      <Show when={state().errorKey}>
        <div class={styles.serverSelectionError} id="server-selection-error" role="alert">{message(state())}</div>
      </Show>
      {props.children}
      <Show when={!connected() || changing()}>
        <div class={styles.serverSelectionActions}>
          <Button
            class={isProgress() ? `btn-primary btn-color-primary ${styles.serverSelectionProgress}` : 'btn-primary btn-color-primary'}
            aria-disabled={isProgress() ? 'true' : undefined}
            disabled={!isProgress() && (!state().host.trim() || isLocked() || props.canContinue?.() === false)}
            onClick={useServer}
          >
            {isProgress() && <svg xmlns="http://www.w3.org/2000/svg" class="preloader-circular" viewBox="25 25 50 50" aria-hidden="true">
              <circle class="preloader-path" cx="50" cy="50" r="20" fill="none" stroke-miterlimit="10"/>
            </svg>}
            {submitLabel()}
          </Button>
          {props.pendingActions}
          <Show when={changing()}>
            <Button
              class="btn-primary btn-secondary btn-primary-transparent primary"
              onClick={onCancelChange}
            >
              {i18n('Cancel')}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={isProgress()}>
        <span class={styles.serverSelectionVisuallyHidden} aria-live="polite">{submitLabel()}</span>
      </Show>
    </div>
  );
}
