import SuperMessagePort from '@lib/superMessagePort';
import {AppMessagesManager} from '@appManagers/appMessagesManager';
import deferredPromise from '@helpers/cancellablePromise';
import handleMediaSendFailure from '@components/popups/mediaSendError';

const mediaMocks = vi.hoisted(() => ({toastNew: vi.fn()}));
vi.mock('@components/toast', () => ({toastNew: mediaMocks.toastNew}));

type TestMethods = {
  call: (payload: {
    kind: 'badResult' | 'transfer' | 'value',
    value?: any
  }) => any,
  notify: (payload: {value: any}) => void
};

type MessageListener = (event: MessageEvent) => void;

class StructuredClonePort {
  private listeners = new Set<MessageListener>();
  public peer?: StructuredClonePort;
  public postMessageError?: Error;

  public addEventListener(type: string, listener: MessageListener) {
    if(type === 'message') {
      this.listeners.add(listener);
    }
  }

  public removeEventListener(type: string, listener: MessageListener) {
    if(type === 'message') {
      this.listeners.delete(listener);
    }
  }

  public postMessage(
    value: any,
    options?: Transferable[] | StructuredSerializeOptions
  ) {
    if(this.postMessageError) {
      throw this.postMessageError;
    }

    const transfer = Array.isArray(options) ? options : options?.transfer;
    const cloned = structuredClone(
      value,
      transfer?.length ? {transfer} : undefined
    );

    queueMicrotask(() => {
      const event = {
        currentTarget: this.peer,
        data: cloned,
        source: null
      } as unknown as MessageEvent;
      this.peer?.dispatch(event);
    });
  }

  private dispatch(event: MessageEvent) {
    this.listeners.forEach((listener) => listener(event));
  }
}

class TestMessagePort extends SuperMessagePort<TestMethods, TestMethods, true> {
  public connect(port: StructuredClonePort) {
    this.attachListenPort(port as any);
    this.sendPorts.push(port as any);
  }

  public get awaitingCount() {
    return Object.keys(this.awaiting).length;
  }

  protected postMessage(port: any, task: any) {
    const ports: StructuredClonePort[] = Array.isArray(port) ? port : [port];
    ports.forEach((port) => port.postMessage(task, task.transfer));
  }
}

function createPair() {
  const clientPort = new StructuredClonePort();
  const workerPort = new StructuredClonePort();
  clientPort.peer = workerPort;
  workerPort.peer = clientPort;

  const client = new TestMessagePort();
  const worker = new TestMessagePort();
  client.connect(clientPort);
  worker.connect(workerPort);

  return {client, worker, clientPort, workerPort};
}

describe('SuperMessagePort structured-clone failures', () => {
  test('degrades an uncloneable batch and keeps cloneable sibling invokes alive', async() => {
    const {client, worker} = createPair();
    worker.addEventListener('call', (payload) => payload.value);

    const badPromise = client.invoke('call', {
      kind: 'value',
      value: () => {}
    });
    const goodPromise = client.invoke('call', {
      kind: 'value',
      value: 'ok'
    });

    await Promise.all([
      expect(badPromise).rejects.toMatchObject({type: 'DATA_CLONE_ERROR'}),
      expect(goodPromise).resolves.toBe('ok')
    ]);
    expect(client.awaitingCount).toBe(0);
  });

  test('replaces uncloneable result and cached ack payloads with clone-safe errors', async() => {
    const {client, worker} = createPair();
    worker.addEventListener('call', (payload) => {
      return payload.kind === 'badResult' ? () => {} : payload.value;
    });

    const resultPromise = client.invoke('call', {kind: 'badResult'});
    const ackPromise = client.invoke('call', {kind: 'badResult'}, true);

    await Promise.all([
      expect(resultPromise).rejects.toMatchObject({type: 'DATA_CLONE_ERROR'}),
      expect(ackPromise).rejects.toMatchObject({type: 'DATA_CLONE_ERROR'})
    ]);
    expect(client.awaitingCount).toBe(0);
  });

  test('preserves transferable results and drops only an uncloneable void invoke', async() => {
    const {client, worker} = createPair();
    const received: any[] = [];
    worker.addEventListener('call', () => {
      const buffer = new Uint8Array([1, 2, 3]).buffer;
      return new SuperMessagePort.TransferableResult(buffer, [buffer]);
    });
    worker.addEventListener('notify', ({value}) => {
      received.push(value);
    });

    client.invokeVoid('notify', {value: () => {}});
    client.invokeVoid('notify', {value: 'ok'});

    const result = await client.invoke('call', {kind: 'transfer'});
    expect([...new Uint8Array(result)]).toEqual([1, 2, 3]);
    await vi.waitFor(() => expect(received).toEqual(['ok']));
    expect(client.awaitingCount).toBe(0);
  });

  test('rejects an invoke locally when a closed port cannot accept its batch', async() => {
    const {client, clientPort} = createPair();
    const error = new Error('MessagePort is closed');
    error.name = 'InvalidStateError';
    clientPort.postMessageError = error;

    const promise = client.invoke('call', {
      kind: 'value',
      value: 'never delivered'
    });

    await expect(promise).rejects.toBe(error);
    expect(client.awaitingCount).toBe(0);
  });

  test('fails pending and future invokes closed when the port cannot be trusted', async() => {
    const {client} = createPair();
    const error = new Error('MTProto worker failed to attach');
    const pending = client.invoke('call', {kind: 'value', value: 'never delivered'});

    client.failClosed(error);

    await expect(pending).rejects.toBe(error);
    await expect(client.invoke('call', {kind: 'value', value: 'blocked'})).rejects.toBe(error);
    expect(client.awaitingCount).toBe(0);
  });
});

describe('media uploads across the manager worker port', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    {outcome: 'rejected', kind: 'photo', mimeType: 'image/jpeg', isMedia: true, isEphemeral: false},
    {outcome: 'rejected', kind: 'document', mimeType: 'application/pdf', isMedia: false, isEphemeral: false},
    {outcome: 'canceled', kind: 'photo', mimeType: 'image/jpeg', isMedia: true, isEphemeral: false},
    {outcome: 'successful', kind: 'photo', mimeType: 'image/jpeg', isMedia: true, isEphemeral: false},
    {outcome: 'rejected', kind: 'photo', mimeType: 'image/jpeg', isMedia: true, isEphemeral: true}
  ])('handles a $outcome $kind upload across the port (ephemeral: $isEphemeral)', async({outcome, kind, mimeType, isMedia, isEphemeral}) => {
    const {client, worker} = createPair();
    const upload = deferredPromise<any>();
    const uploadFile = vi.fn(() => upload);
    const message: any = {_: 'message', id: 1, pFlags: {}, random_id: '123'};
    Object.defineProperties(message, {
      send: {writable: true, configurable: true},
      promise: {value: deferredPromise<void>(), writable: true, configurable: true}
    });
    const manager = new AppMessagesManager() as any;
    Object.assign(manager, {
      appPeersManager: {
        getPeerMigratedTo: (): PeerId => undefined,
        getInputPeerById: () => ({_: 'inputPeerSelf'})
      },
      getEphemeralSendContext: () => isEphemeral ? {receiverId: 1} : undefined,
      checkSendOptions: async(): Promise<void> => undefined,
      generateOutgoingMessage: () => message,
      makeDocumentAndMetaForSendingFile: (): any => ({
        document: isMedia ? undefined : {_: 'document', id: '1'},
        photo: isMedia ? {_: 'photo', id: '1'} : undefined,
        apiFileName: kind,
        actionName: undefined,
        fileType: mimeType,
        mediaUnread: false,
        attributes: [],
        attachType: kind
      }),
      getInputEntities: (): any[] => [],
      uploadFilePromises: {},
      apiFileManager: {upload: uploadFile},
      apiManager: {invokeApi: vi.fn().mockResolvedValue({_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0})},
      apiUpdatesManager: {processUpdateMessage: vi.fn(), processPaidMessageUpdate: vi.fn()},
      sendSmthLazyLoadQueue: {push: ({load}: any): void => void load().catch(() => {})},
      beforeMessageSending: (outgoing: any) => outgoing.send(),
      cancelPendingMessage: vi.fn(),
      setTyping: vi.fn(),
      onMessagesSendError: vi.fn(),
      registerEphemeralRetry: vi.fn(),
      rootScope: {dispatchEvent: vi.fn()},
      log: Object.assign(vi.fn(), {error: vi.fn()})
    });

    worker.addEventListener('call', () => manager.sendGrouped({
      peerId: 1 as PeerId,
      isMedia,
      sendFileDetails: [{file: new File(['data'], kind, {type: mimeType})}]
    }));
    const request = client.invoke('call', {kind: 'value'});
    let settled = false;
    request.then(() => settled = true, () => settled = true);
    const handled = handleMediaSendFailure(request);

    await vi.waitFor(() => expect(uploadFile).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    if(outcome === 'successful') {
      upload.resolve({_: 'inputFile', id: '1', parts: 1, name: kind, md5_checksum: ''});
    } else {
      upload.reject({type: outcome === 'canceled' ? 'UPLOAD_CANCELED' : 'UPLOAD_DISABLED', code: 403});
    }
    await handled;

    if(outcome === 'rejected') {
      expect(mediaMocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Error.AnError'});
    } else {
      expect(mediaMocks.toastNew).not.toHaveBeenCalled();
    }
    if(outcome === 'successful') {
      expect(manager.cancelPendingMessage).not.toHaveBeenCalled();
      expect(manager.apiManager.invokeApi).toHaveBeenCalledWith('messages.sendMedia', expect.any(Object));
    } else {
      expect(manager.cancelPendingMessage).toHaveBeenCalledWith('123');
    }
    if(isEphemeral) {
      expect(manager.registerEphemeralRetry).toHaveBeenCalledOnce();
      expect(manager.onMessagesSendError).not.toHaveBeenCalled();
    }
  });

  it.each(['success first', 'failure first'])('marks every pending album message failed when one upload fails (%s)', async(order) => {
    const {client, worker} = createPair();
    const uploads = [deferredPromise<any>(), deferredPromise<any>()];
    const sends = uploads.map((upload) => vi.fn(() => upload));
    const messages: any[] = [1, 2].map((id) => ({
      _: 'message', id, mid: id, peerId: 1 as PeerId, storageKey: '1_history',
      random_id: String(id), pFlags: {}, pending: true
    }));
    const storage = new Map(messages.map((message) => [message.mid, message]));
    const dispatchEvent = vi.fn();
    const photo = {_: 'photo', id: '1', access_hash: '2', file_reference: new Uint8Array(), date: 0, sizes: [] as any[], dc_id: 1, pFlags: {}};
    const invokeApi = vi.fn(async(method: string): Promise<any> => {
      if(method === 'messages.uploadMedia') return {_: 'messageMediaPhoto', pFlags: {}, photo};
      throw new Error(`Unexpected method: ${method}`);
    });
    const sendFile = vi.fn(async(options: any): Promise<any> => {
      const index = options.file.name === 'first.jpg' ? 0 : 1;
      return {message: messages[index], send: sends[index], uploadingFileName: `file-${index}`};
    });
    const log: any = vi.fn();
    log.error = vi.fn();
    log.bindPrefix = () => log;
    const manager = new AppMessagesManager() as any;
    Object.assign(manager, {
      appPeersManager: {
        getPeerMigratedTo: (): PeerId => undefined,
        getInputPeerById: () => ({_: 'inputPeerSelf'})
      },
      getEphemeralSendContext: (): undefined => undefined,
      checkSendOptions: async(): Promise<void> => undefined,
      getInputEntities: (): any[] => [],
      groupedTempId: 0,
      sendFile,
      apiManager: {invokeApi},
      appPhotosManager: {savePhoto: (value: any): any => value},
      apiFileManager: {cancelDownload: vi.fn()},
      onMessageModification: (message: any): void => { storage.set(message.mid, message); },
      updateMessageContext: vi.fn(),
      getDialogOnly: (): undefined => undefined,
      rootScope: {dispatchEvent},
      setTyping: vi.fn(),
      log
    });
    worker.addEventListener('call', () => manager.sendGrouped({
      peerId: 1 as PeerId,
      isMedia: true,
      sendFileDetails: [
        {file: new File(['one'], 'first.jpg', {type: 'image/jpeg'})},
        {file: new File(['two'], 'second.jpg', {type: 'image/jpeg'})}
      ]
    }));
    const handled = handleMediaSendFailure(client.invoke('call', {kind: 'value'}));
    await vi.waitFor(() => {
      expect(sends[0]).toHaveBeenCalledOnce();
      expect(sends[1]).toHaveBeenCalledOnce();
    });

    const input = {_: 'inputMediaUploadedPhoto', file: {_: 'inputFile', id: '1', parts: 1, name: 'first.jpg', md5_checksum: ''}, pFlags: {}};
    if(order === 'success first') {
      uploads[0].resolve(input);
      await vi.waitFor(() => expect(invokeApi).toHaveBeenCalledWith('messages.uploadMedia', expect.any(Object)));
    }
    uploads[1].reject({type: 'UPLOAD_DISABLED', code: 403});
    await handled;
    if(order === 'failure first') {
      uploads[0].resolve(input);
      await vi.waitFor(() => expect(invokeApi).toHaveBeenCalledWith('messages.uploadMedia', expect.any(Object)));
    }

    expect([...storage.values()].map((message) => message.error?.type)).toEqual(['UPLOAD_DISABLED', 'UPLOAD_DISABLED']);
    expect(dispatchEvent.mock.calls.filter(([event]) => event === 'message_error')).toHaveLength(2);
    expect(invokeApi.mock.calls.some(([method]) => method === 'messages.sendMultiMedia')).toBe(false);
    expect(mediaMocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Error.AnError'});
  });
});
