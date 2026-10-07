import {createSignal} from 'solid-js';
import {render} from 'solid-js/web';

import AccountController from '@lib/accounts/accountController';
import classNames from '@helpers/string/classNames';
import themeController from '@helpers/themeController';
import I18n from '@lib/langPack';
import rootScope from '@lib/rootScope';
import {AuthFlowContext} from '@/pages/authFlow';
import type {AuthFlowContextValue, CardSpec} from '@/pages/authFlow';
import styles from '@/pages/authFlow.module.scss';
import {SETTINGS_INIT} from '@config/state';
import {setAppSettingsSilent} from '@stores/appSettings';
import {GrowHeightReveal} from '@helpers/solid/animations';
import StarsMoreOptionsButton from '@components/popups/starsMoreOptionsButton';

import '@/materialize.scss';
import '@/scss/style.scss';

const QR_FIXTURE_ARTIFACT_MARKER = 'TWEB_QR_FIXTURE_DEV_ONLY_SENTINEL_6D9B42E1';
const UNEXPECTED_MANAGER_ERROR = 'Synthetic QR fixture received an unexpected manager call';
const TOKEN_BYTES = new Uint8Array([81, 82, 45, 70, 73, 88, 84, 85, 82, 69]);
const TOKEN_EXPIRY = 4_102_444_800;

export type QrFixtureOutcome = 'input-method-invalid' | 'network-bad-response-406' | 'token';
export type QrFixtureTheme = 'day' | 'night';

type ManagerHandler = (...args: unknown[]) => unknown;
type ManagerHandlers = Record<string, Record<string, ManagerHandler>>;

type QrFixtureControl = {
  selectOutcome(outcome: QrFixtureOutcome): void,
  setTheme(theme: QrFixtureTheme): void,
  setRevealProbeVisible(visible: boolean): void,
  setStarsMoreOptionsVisible(visible: boolean): void,
  completePendingToken(): void,
  inspect(): {
    outcome: QrFixtureOutcome,
    managerCalls: string[],
    unexpectedManagerCalls: string[],
    actions: string[]
  }
};

declare global {
  interface Window {
    qrFixture?: QrFixtureControl
  }
}

function makeAuthError(type: string, code?: number) {
  return Object.assign(new Error('Synthetic QR fixture error'), {type, code});
}

function makeTokenResponse() {
  return {_: 'auth.loginToken', token: new Uint8Array(TOKEN_BYTES), expires: TOKEN_EXPIRY};
}

function hasEmptyExceptIds(params: unknown) {
  if(!params || typeof(params) !== 'object' || !('except_ids' in params)) return false;
  const exceptIds = (params as {except_ids?: unknown}).except_ids;
  return Array.isArray(exceptIds) && exceptIds.length === 0;
}

export async function mountQrFixtureApp(
  initialOutcome: QrFixtureOutcome,
  isQrFixtureOutcome: (value: string) => value is QrFixtureOutcome
) {
  let selectedOutcome = initialOutcome;
  const managerCalls = new Set<string>();
  const unexpectedManagerCalls = new Set<string>();
  const actions: string[] = [];
  const pendingTokenResolvers: Array<() => void> = [];
  let updateRevealProbes: ((visible: boolean) => void) | undefined;
  let updateStarsMoreOptionsVisible: ((visible: boolean) => void) | undefined;
  const showSuggestedLanguage = new URLSearchParams(window.location.search).get('suggested-language') === '1';

  const handlers: ManagerHandlers = {
    apiManager: {
      setThemeParams() {},
      invokeApi(method, params) {
        if(method !== 'auth.exportLoginToken' || !hasEmptyExceptIds(params)) {
          unexpectedManagerCalls.add('apiManager.invokeApi:unexpected');
          return Promise.reject(makeAuthError('QR_FIXTURE_UNEXPECTED_MANAGER_CALL'));
        }
        if(selectedOutcome === 'input-method-invalid') {
          return Promise.reject(makeAuthError('INPUT_METHOD_INVALID'));
        }
        if(selectedOutcome === 'network-bad-response-406') {
          return Promise.reject(makeAuthError('NETWORK_BAD_RESPONSE', 406));
        }

        return new Promise((resolve) => {
          pendingTokenResolvers.push(() => resolve(makeTokenResponse()));
        });
      },
      async getConfig() {
        return {suggested_lang_code: showSuggestedLanguage ? 'fixture-language' : I18n.getLastRequestedLangCode()};
      },
      async getBaseDcId() {
        return 1;
      },
      async setBaseDcId() {},
      async setUser() {}
    },
    appLangPackManager: {
      async getStrings(langCode: unknown, strings: unknown) {
        if(langCode !== 'fixture-language' || !Array.isArray(strings) ||
          !strings.includes('Login.ContinueOnLanguage')) {
          unexpectedManagerCalls.add('appLangPackManager.getStrings:unexpected');
          throw new Error(UNEXPECTED_MANAGER_ERROR);
        }

        return [{_: 'langPackString', key: 'Login.ContinueOnLanguage', value: 'Continue in fixture language'}];
      }
    },
    appAccountManager: {
      async initPasskeyLogin() {
        return {options: {data: '{"publicKey":{}}'}};
      },
      async finishPasskeyLogin() {}
    },
    appStateManager: {
      async pushToState() {}
    },
    timeManager: {
      async getServerTimeOffset() {
        return 0;
      }
    }
  };

  const managers = new Proxy({}, {
    get(_target, managerName: string) {
      if(managerName === 'then') return undefined;
      return new Proxy({}, {
        get(_manager, methodName: string) {
          if(methodName === 'then') return undefined;
          return (...args: unknown[]) => {
            const isExport = managerName === 'apiManager' && methodName === 'invokeApi' &&
              args[0] === 'auth.exportLoginToken';
            const callName = managerName === 'apiManager' && methodName === 'invokeApi' ?
              `apiManager.invokeApi:${isExport ? 'auth.exportLoginToken' : 'unexpected'}` :
              `${managerName}.${methodName}`;
            managerCalls.add(callName);

            const handler = handlers[managerName]?.[methodName];
            if(!handler || managerName === 'apiManager' && methodName === 'invokeApi' && !isExport) {
              unexpectedManagerCalls.add(callName);
              return Promise.reject(new Error(UNEXPECTED_MANAGER_ERROR));
            }

            return handler(...args);
          };
        }
      });
    }
  }) as typeof rootScope.managers;

  const failClosedAccountRead: typeof AccountController.getUserIds = async() => [];
  AccountController.getUserIds = failClosedAccountRead;
  rootScope.managers = managers;
  const dispatchEvent = rootScope.dispatchEvent;
  rootScope.dispatchEvent = ((name: string, ...args: unknown[]) => {
    if(name === 'language_change') {
      rootScope.dispatchEventSingle('language_change', args[0] as string);
      return;
    }

    dispatchEvent(name as any, ...(args as any));
  }) as typeof rootScope.dispatchEvent;
  try {
    await I18n.getCacheLangPackAndApply();
  } finally {
    rootScope.dispatchEvent = dispatchEvent;
  }

  function applyTheme(theme: QrFixtureTheme) {
    themeController.applyTheme(themeController.getTheme(theme), document.documentElement);
    document.documentElement.classList.toggle('night', theme === 'night');
  }

  setAppSettingsSilent('theme', 'day');
  setAppSettingsSilent('themes', SETTINGS_INIT.themes);
  applyTheme('day');

  const control: QrFixtureControl = Object.freeze({
    selectOutcome(outcome) {
      if(!isQrFixtureOutcome(outcome)) throw new Error(UNEXPECTED_MANAGER_ERROR);
      selectedOutcome = outcome;
    },
    setTheme(theme) {
      if(theme !== 'day' && theme !== 'night') throw new Error(UNEXPECTED_MANAGER_ERROR);
      applyTheme(theme);
      rootScope.dispatchEventSingle('theme_changed');
    },
    setRevealProbeVisible(visible) {
      if(typeof(visible) !== 'boolean' || !updateRevealProbes) throw new Error(UNEXPECTED_MANAGER_ERROR);
      updateRevealProbes(visible);
    },
    setStarsMoreOptionsVisible(visible) {
      if(typeof(visible) !== 'boolean' || !updateStarsMoreOptionsVisible) throw new Error(UNEXPECTED_MANAGER_ERROR);
      updateStarsMoreOptionsVisible(visible);
    },
    completePendingToken() {
      pendingTokenResolvers.shift()?.();
    },
    inspect() {
      return {
        outcome: selectedOutcome,
        managerCalls: [...managerCalls].sort(),
        unexpectedManagerCalls: [...unexpectedManagerCalls].sort(),
        actions: [...actions]
      };
    }
  });

  window.qrFixture = control;
  const host = document.getElementById('qr-fixture-root');
  if(!host) {
    throw new Error(UNEXPECTED_MANAGER_ERROR);
  }
  host.dataset.qrFixtureMarker = QR_FIXTURE_ARTIFACT_MARKER;

  const flowContext: AuthFlowContextValue = {
    managers,
    current: () => ({name: 'signQR'}),
    navigate: (spec: CardSpec) => actions.push(`navigate:${spec.name}`),
    back: () => actions.push('back'),
    toIm: async() => {
      actions.push('toIm');
    }
  };

  const {default: SignQRCard} = await import('@/pages/cards/SignQRCard');
  render(() => {
    const [revealProbesVisible, setRevealProbesVisible] = createSignal(false);
    const [starsMoreOptionsVisible, setStarsMoreOptionsVisible] = createSignal(false);
    updateRevealProbes = setRevealProbesVisible;
    updateStarsMoreOptionsVisible = setStarsMoreOptionsVisible;
    return (
      <>
        <AuthFlowContext.Provider value={flowContext}>
          <div id="auth-pages" class={classNames('whole', styles.host)}>
            <div class={styles.scrollable}>
              <div class={classNames(styles.placeholder, styles.placeholderTop)}/>
              <div class={styles.cardsContainer} data-qr-fixture-cards-container="">
                <SignQRCard spec={{name: 'signQR'}}/>
              </div>
              <div class={styles.placeholder}/>
            </div>
          </div>
        </AuthFlowContext.Provider>
        <GrowHeightReveal when={revealProbesVisible()} class="accent-picker-frame">
          <div class="accent-picker" data-qr-fixture-reveal-probe="accent">Accent picker</div>
        </GrowHeightReveal>
        <GrowHeightReveal when={revealProbesVisible()} class="primary-action-focus-inset">
          <button class="btn-primary btn-primary-transparent" data-qr-fixture-reveal-probe="passkey">
            Log in by passkey
          </button>
        </GrowHeightReveal>
        <StarsMoreOptionsButton when={starsMoreOptionsVisible()} onClick={() => {}} />
      </>
    );
  }, host);
  host.dataset.qrFixtureReady = 'true';
}
