import ServiceMessagePort from '@lib/serviceWorker/serviceMessagePort';
import App from '@config/app';
import {MOUNT_CLASS_TO} from '@config/debug';
import callbackify from '@helpers/callbackify';
import deferredPromise, {CancellablePromise} from '@helpers/cancellablePromise';
import cryptoMessagePort from '@lib/crypto/cryptoMessagePort';
import lottieMessagePort from '@lib/lottie/lottieMessagePort';
import {THREADED_WORKER_TYPES, ThreadedWorkerType} from '@lib/threadedWorkerTypes';
import MTProtoMessagePort from '@lib/mainWorker/mainMessagePort';
import {AppStoragesManager} from '@appManagers/appStoragesManager';
import createManagers from '@appManagers/createManagers';
import {performancePhaseTrace} from '@appManagers/performanceTrace';
import {ActiveAccountNumber} from '@lib/accounts/types';
import AppStateManager from '@appManagers/appStateManager';
import rootScope from '@lib/rootScope';
import AccountController from '@lib/accounts/accountController';
import pushSingleManager from '@appManagers/pushSingleManager';
import Modes from '@config/modes';
import SuperMessagePort from '@lib/superMessagePort';
import objectUrlRegistry from '@lib/mainWorker/objectUrlRegistry';
import {makeObjectUrlOwner, parseObjectUrlOwner} from '@helpers/objectUrlUtils';
import {releaseSharedObjectURLsWhere} from '@lib/mainWorker/sharedObjectUrlCache';

type Managers = Awaited<ReturnType<typeof createManagers>>;

// for testing cases without video streaming
const CAN_USE_SERVICE_WORKER = !Modes.noServiceWorker;

type ManagersByAccount = Record<ActiveAccountNumber, Managers>;
type StateManagersByAccount = Record<ActiveAccountNumber, AppStateManager>;

type ThreadedSharedWorker = {
  urls: string[],
  attached: number,
  promise: CancellablePromise<void>,
  superMessagePort?: SuperMessagePort<any, any, any>,
  threads: number
};

export class AppManagersManager {
  private managersByAccount: Partial<ManagersByAccount> = {};
  private managersByAccountPromises: Partial<Record<ActiveAccountNumber, Promise<Managers>>> = {};
  public readonly stateManagersByAccount: StateManagersByAccount;
  private threadedSharedWorkers: {[type in ThreadedWorkerType]?: ThreadedSharedWorker};

  private _isServiceWorkerOnline: boolean;

  private serviceMessagePort: ServiceMessagePort<true>;
  private _serviceMessagePort: MessagePort

  constructor() {
    this._isServiceWorkerOnline = CAN_USE_SERVICE_WORKER;

    this.threadedSharedWorkers = {};
    for(
      const {type, superMessagePort, threads} of THREADED_WORKER_TYPES.map((type) => {
        return {
          type,
          superMessagePort: type === 'crypto' ? cryptoMessagePort : lottieMessagePort,
          threads: type === 'crypto' ? App.cryptoWorkers : App.lottieWorkers
        };
      })
    ) {
      this.threadedSharedWorkers[type] = {
        urls: [],
        attached: 0,
        promise: deferredPromise(),
        superMessagePort,
        threads
      };

      this.threadedSharedWorkers[type].promise.then(() => {
        this.threadedSharedWorkers[type].promise = undefined;
      });
    }

    this.stateManagersByAccount = {
      1: new AppStateManager(1),
      2: new AppStateManager(2),
      3: new AppStateManager(3),
      4: new AppStateManager(4)
    };

    const managersByAccountAsArray = Object.values(this.stateManagersByAccount)

    managersByAccountAsArray.forEach((stateManager) => {
      stateManager.onSettingsUpdate = (settingsValue) => {
        managersByAccountAsArray.forEach((stateManagerToUpdate) => {
          if(stateManager !== stateManagerToUpdate)
            stateManagerToUpdate.updateLocalState('settings', settingsValue);
        });
      }
    })
  }

  public start() {
    const port = MTProtoMessagePort.getInstance<false>();

    port.addEventListener('manager', ({name, method, args, accountNumber}) => {
      if(accountNumber === undefined) {
        return callbackify(this.getManagersByAccount(), (managersByAccount) => {
          const results: any[] = [];
          for(const accountNumber in managersByAccount) {
            const managers = managersByAccount[+accountNumber as any as ActiveAccountNumber];
            const manager = managers[name as keyof Managers];
            // @ts-ignore
            results.push(manager[method](...args));
          }

          return results.some((result) => result instanceof Promise) ? Promise.all(results) : results;
        });
      }

      return callbackify(this.getManagersByAccount(accountNumber), (managers) => {
        const manager = managers[name as keyof Managers];
        // @ts-ignore
        return manager[method](...args);
      });
    });

    port.addEventListener('threadedPort', (type, source, event) => {
      const threadedWorker = this.threadedSharedWorkers[type];
      const port = event.ports[0];
      // A threaded worker can post its MessagePort before createProxyWorkerURLs
      // has populated urls, so cap by the configured thread count instead.
      if(threadedWorker.attached >= threadedWorker.threads) {
        port.close();
        return;
      }

      ++threadedWorker.attached;
      threadedWorker.superMessagePort.attachPort(port);
      threadedWorker.promise?.resolve();
    });

    port.addEventListener('createProxyWorkerURLs', ({originalUrl, blob, type}) => {
      const {urls, threads} = this.threadedSharedWorkers[type];
      let length = urls.length;
      if(!length) {
        urls.push(originalUrl);
        ++length;
      }

      const maxLength = threads;
      if(length === maxLength) {
        return urls;
      }

      const newURLs = new Array(maxLength - length).fill(undefined).map((_, index) => {
        const owner = makeObjectUrlOwner('threaded-worker', type, length + index);
        return objectUrlRegistry.createShared(blob, owner);
      });
      urls.push(...newURLs);
      return urls;
    });

    rootScope.addEventListener('account_logged_in', async({accountNumber, userId, isNewAccount}) => {
      for(let i = 1; i < accountNumber; i++) {
        const otherAccountNumber = i as ActiveAccountNumber;
        const accountData = await AccountController.get(otherAccountNumber);
        if(accountData.userId === userId && !isNewAccount) {
          const managers = await this.getManagersByAccount(accountNumber);
          managers.apiManager.logOut(otherAccountNumber);
        }
      }
    });

    rootScope.addEventListener('logging_out', ({accountNumber}) => {
      releaseSharedObjectURLsWhere((owner) => {
        const details = parseObjectUrlOwner(owner);
        return !!details &&
          details.namespace !== 'threaded-worker' &&
          (accountNumber === undefined || details.parts[0] === accountNumber);
      });
    });
  }

  private async createManagers(accountNumber: ActiveAccountNumber) {
    const finishStartup = performancePhaseTrace.start('worker.account.startup', {accountNumber});
    const stateManager = this.stateManagersByAccount[accountNumber];
    const appStoragesManager = new AppStoragesManager(accountNumber, stateManager.resetStoragesPromise);

    try {
      const finishStorageLoad = performancePhaseTrace.start('worker.storage.load', {accountNumber});
      const storageLoad = appStoragesManager.loadStorages().finally(finishStorageLoad);
      // In Modes.noWorker the crypto worker is never spawned — the registry
      // is imported into the main realm and cryptoMessagePort short-circuits
      // same-realm callers via invokeCryptoNew's early-out. There's nothing
      // to wait for and the threadedPort handshake never resolves, so skip.
      // An absent promise in worker mode also means the handshake has finished.
      const finishCryptoReady = performancePhaseTrace.start('worker.crypto.ready', {accountNumber});
      const cryptoPromise = this.threadedSharedWorkers.crypto.promise;
      const cryptoReady = (Modes.noWorker || !cryptoPromise ? Promise.resolve() : cryptoPromise).finally(finishCryptoReady);
      await Promise.all([storageLoad, cryptoReady]);

      const finishManagerCreation = performancePhaseTrace.start('worker.managers.create', {accountNumber});
      const managers = await createManagers(
        appStoragesManager,
        stateManager,
        accountNumber,
        stateManager.userId
      ).finally(finishManagerCreation);

      this.managersByAccount[accountNumber] = managers;
      return managers;
    } finally {
      finishStartup();
    }
  }

  // * Started managers are returned as-is, not wrapped in a promise: callbackify then
  // * runs a manager call in the same tick, keeping it ordered with update events.
  public getManagersByAccount(accountNumber: ActiveAccountNumber): MaybePromise<Managers>;
  public getManagersByAccount(): MaybePromise<ManagersByAccount>;
  public getManagersByAccount(accountNumber?: ActiveAccountNumber) {
    if(accountNumber !== undefined) {
      return this.managersByAccount[accountNumber] ??
        (this.managersByAccountPromises[accountNumber] ??= this.createManagers(accountNumber));
    }

    if(this.areManagersCreated) {
      return this.managersByAccount as ManagersByAccount;
    }

    return Promise.all(([1, 2, 3, 4] as ActiveAccountNumber[]).map((accountNumber) => {
      return this.managersByAccountPromises[accountNumber] ??= this.createManagers(accountNumber);
    })).then(() => this.managersByAccount as ManagersByAccount);
  }

  // * For diagnostics only (see memoryStats): reading a report must never be what CREATES the
  // * managers - getManagersByAccount() would do exactly that.
  public get areManagersCreated() {
    return Object.keys(this.managersByAccount).length === 4;
  }

  public get isServiceWorkerOnline() {
    return this._isServiceWorkerOnline;
  }

  public set isServiceWorkerOnline(value) {
    this._isServiceWorkerOnline = CAN_USE_SERVICE_WORKER ? value : false;
  }

  public getServiceMessagePort() {
    return this._isServiceWorkerOnline ? this.serviceMessagePort : undefined;
  }

  public onServiceWorkerPort(event: MessageEvent<any>) {
    if(this.serviceMessagePort) {
      this.serviceMessagePort.detachPort(this._serviceMessagePort);
      this._serviceMessagePort = undefined;
    } else {
      this.serviceMessagePort = new ServiceMessagePort();
      this.serviceMessagePort.addMultipleEventsListeners({
        requestFilePart: (payload) => {
          return callbackify(appManagersManager.getManagersByAccount(payload.accountNumber), (managers) => {
            const {docId, dcId, offset, limit} = payload;
            return managers.appDocsManager.requestDocPart(docId, dcId, offset, limit);
          });
        },
        cancelFilePartRequests: ({docId, accountNumber}) => {
          return callbackify(appManagersManager.getManagersByAccount(accountNumber), (managers) => {
            return managers.appDocsManager.cancelDocPartsRequests(docId);
          });
        },
        requestRtmpState({call, accountNumber}) {
          return callbackify(appManagersManager.getManagersByAccount(accountNumber), (managers) => {
            return managers.appGroupCallsManager.fetchRtmpState(call);
          });
        },
        requestRtmpPart(payload) {
          return callbackify(appManagersManager.getManagersByAccount(payload.accountNumber), (managers) => {
            const {request, dcId} = payload;
            return managers.appGroupCallsManager.fetchRtmpPart(request, dcId);
          });
        },
        requestDoc(payload) {
          return callbackify(appManagersManager.getManagersByAccount(payload.accountNumber), (managers) => {
            return managers.appDocsManager.getDoc(payload.docId);
          });
        },
        downloadDoc(payload) {
          return callbackify(appManagersManager.getManagersByAccount(payload.accountNumber), (managers) => {
            const {docId} = payload;
            const appDocsManager = managers.appDocsManager;
            const doc = appDocsManager.getDoc(docId);
            return appDocsManager.downloadDoc(doc);
          });
        },
        requestAltDocsByDoc(payload) {
          return callbackify(appManagersManager.getManagersByAccount(payload.accountNumber), (managers) => {
            const {docId} = payload;
            const {appDocsManager} = managers;
            return appDocsManager.getAltDocsByDocument(docId);
          });
        },
        decryptPush(payload) {
          return pushSingleManager.decryptPush(payload.p, payload.keyIdBase64);
        }
      });
    }

    // * port can be undefined in the future
    if(this._serviceMessagePort = event.ports[0]) {
      this.serviceMessagePort.attachPort(this._serviceMessagePort);
    }
  }
}

const appManagersManager = new AppManagersManager();
MOUNT_CLASS_TO && (MOUNT_CLASS_TO.appManagersManager = appManagersManager);
export default appManagersManager;
