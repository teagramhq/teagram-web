import {render} from 'solid-js/web';

import AccountController from '@lib/accounts/accountController';
import I18n from '@lib/langPack';
import rootScope from '@lib/rootScope';
import {AuthFlowContext} from '@/pages/authFlow';
import type {AuthFlowContextValue, CardSpec} from '@/pages/authFlow';

import '@/materialize.scss';
import '@/scss/style.scss';

const QR_FIXTURE_ARTIFACT_MARKER = 'TWEB_QR_FIXTURE_DEV_ONLY_SENTINEL_6D9B42E1';
const UNEXPECTED_MANAGER_ERROR = 'Synthetic QR fixture received an unexpected manager call';
const TOKEN_BYTES = new Uint8Array([81, 82, 45, 70, 73, 88, 84, 85, 82, 69]);
const TOKEN_EXPIRY = 4_102_444_800;

export type QrFixtureOutcome = 'input-method-invalid' | 'network-bad-response-406' | 'token';

type ManagerHandler = (...args: unknown[]) => unknown;
type ManagerHandlers = Record<string, Record<string, ManagerHandler>>;

type QrFixtureControl = {
  selectOutcome(outcome: QrFixtureOutcome): void,
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

  const handlers: ManagerHandlers = {
    apiManager: {
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
        return {suggested_lang_code: I18n.getLastRequestedLangCode()};
      },
      async getBaseDcId() {
        return 1;
      },
      async setBaseDcId() {},
      async setUser() {}
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

  const control: QrFixtureControl = Object.freeze({
    selectOutcome(outcome) {
      if(!isQrFixtureOutcome(outcome)) throw new Error(UNEXPECTED_MANAGER_ERROR);
      selectedOutcome = outcome;
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
  render(() => (
    <AuthFlowContext.Provider value={flowContext}>
      <SignQRCard spec={{name: 'signQR'}}/>
    </AuthFlowContext.Provider>
  ), host);
  host.dataset.qrFixtureReady = 'true';
}
