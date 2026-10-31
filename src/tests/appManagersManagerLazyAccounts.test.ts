import {vi} from 'vitest';

const {createdAccounts, modes} = vi.hoisted(() => ({
  createdAccounts: [] as number[],
  modes: {noWorker: true}
}));

vi.mock('@appManagers/appStateManager', () => ({
  default: class {
    userId: number;
    onSettingsUpdate: (value: unknown) => void;
    resetStoragesPromise = {};
  }
}));

vi.mock('@appManagers/appStoragesManager', () => ({
  AppStoragesManager: class {
    loadStorages() {
      return Promise.resolve();
    }
  }
}));

vi.mock('@appManagers/createManagers', () => ({
  default: async(_storages: unknown, _stateManager: unknown, accountNumber: number) => {
    createdAccounts.push(accountNumber);
    return {accountNumber};
  }
}));

vi.mock('@config/modes', () => ({
  default: modes
}));

import {AppManagersManager} from '@appManagers/appManagersManager';

describe('AppManagersManager account startup', () => {
  beforeEach(() => {
    createdAccounts.length = 0;
    modes.noWorker = true;
  });

  it('starts only the requested account', async() => {
    const manager = new AppManagersManager();
    const managers = await manager.getManagersByAccount(2);

    expect(createdAccounts).toEqual([2]);
    expect(managers).toHaveProperty('accountNumber', 2);
  });

  it('reuses an in-flight startup for concurrent requests to one account', async() => {
    const manager = new AppManagersManager();
    const [first, second] = await Promise.all([
      manager.getManagersByAccount(3),
      manager.getManagersByAccount(3)
    ]);

    expect(createdAccounts).toEqual([3]);
    expect(first).toBe(second);
  });

  it('starts an account after the crypto worker is ready', async() => {
    modes.noWorker = false;
    const manager = new AppManagersManager();
    const cryptoWorker = (manager as unknown as {
      threadedSharedWorkers: {
        crypto: {promise?: Promise<void> & {resolve?: (value: void) => void}}
      }
    }).threadedSharedWorkers.crypto;
    const cryptoPromise = cryptoWorker.promise;
    cryptoPromise.resolve?.(undefined);
    await cryptoPromise;

    expect(cryptoWorker.promise).toBeUndefined();

    const managers = await manager.getManagersByAccount(2);

    expect(createdAccounts).toEqual([2]);
    expect(managers).toHaveProperty('accountNumber', 2);
  });

  it('starts every account for all-account operations', async() => {
    const manager = new AppManagersManager();
    const managers = await manager.getManagersByAccount();

    expect(createdAccounts).toEqual([1, 2, 3, 4]);
    expect(Object.keys(managers)).toEqual(['1', '2', '3', '4']);
  });

  it('returns started managers synchronously so manager calls keep their order', async() => {
    const manager = new AppManagersManager();
    const managers = await manager.getManagersByAccount(2);
    const managersByAccount = await manager.getManagersByAccount();

    expect(manager.getManagersByAccount(2)).toBe(managers);
    expect(manager.getManagersByAccount()).toBe(managersByAccount);
  });
});
