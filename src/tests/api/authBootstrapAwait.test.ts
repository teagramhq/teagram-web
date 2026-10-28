import {afterEach, describe, expect, it, vi} from 'vitest';

import AppAccountManager from '@appManagers/appAccountManager';
import {PasswordManager} from '@appManagers/passwordManager';

const AUTHORIZATION = {_: 'auth.authorization', user: {_: 'user', id: 42}};

function createBootstrapGate() {
  let markStarted!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const setUser = vi.fn(async() => {
    markStarted();
    await pending;
  });

  return {started, finish, setUser};
}

async function expectAuthorizationWaitsForBootstrap(
  authorizationPromise: Promise<unknown>,
  bootstrap: ReturnType<typeof createBootstrapGate>
) {
  let completed = false;
  const result = authorizationPromise.then((authorization) => {
    completed = true;
    return authorization;
  });

  await bootstrap.started;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(completed).toBe(false);

  bootstrap.finish();
  await expect(result).resolves.toBe(AUTHORIZATION);
}

afterEach(() => vi.restoreAllMocks());

describe('auth bootstrap completion', () => {
  it('waits for passkey authorization to set the user before returning', async() => {
    const bootstrap = createBootstrapGate();
    const manager = Object.create(AppAccountManager.prototype) as AppAccountManager;
    Object.assign(manager, {
      apiManager: {
        invokeApi: vi.fn(async() => AUTHORIZATION),
        setUser: bootstrap.setUser
      }
    });

    await expectAuthorizationWaitsForBootstrap(manager.finishPasskeyLogin({} as any), bootstrap);
  });

  it('waits for password sign-in to set the user before returning', async() => {
    const bootstrap = createBootstrapGate();
    const manager = Object.create(PasswordManager.prototype) as PasswordManager;
    Object.assign(manager, {
      apiManager: {
        invokeApi: vi.fn(async() => AUTHORIZATION),
        setUser: bootstrap.setUser
      }
    });
    vi.spyOn(manager, 'getInputCheckPassword').mockResolvedValue({} as any);

    await expectAuthorizationWaitsForBootstrap(manager.check('password', {} as any), bootstrap);
  });

  it('waits for password-reset authorization to set the user before returning', async() => {
    const bootstrap = createBootstrapGate();
    const manager = Object.create(PasswordManager.prototype) as PasswordManager;
    Object.assign(manager, {
      apiManager: {
        invokeApi: vi.fn(async() => AUTHORIZATION),
        setUser: bootstrap.setUser
      }
    });

    await expectAuthorizationWaitsForBootstrap(manager.confirmPasswordResetEmail('code'), bootstrap);
  });
});
