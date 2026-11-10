import {afterEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {ApiUpdatesManager} from '@appManagers/apiUpdatesManager';
import {AppMessagesManager} from '@appManagers/appMessagesManager';
const realClientBrowser = require('../../scripts/real-client/browser.cjs');

const TRACE_ENABLED = '__realClientMessageAckTraceEnabled';
const TRACE_CHECK_NAME = '__realClientMessageAckTraceCheckName';
const TRACE_STATE = '__realClientMessageAckTraceState';

function setTraceSwitch(enabled: boolean) {
  const scope = window as any;
  scope[TRACE_ENABLED] = enabled;
  scope[TRACE_CHECK_NAME] = 'alice_group_message_message_count';
  delete scope[TRACE_STATE];
}

function createSendHarness() {
  const randomId = '123456789';
  const peerId = 777 as PeerId;
  const tempId = 1.0001;
  const storage = {key: '777_history'};
  const tempMessage = {_: 'message', mid: tempId, pFlags: {is_outgoing: true}};
  let resolveApiResult: (value: unknown) => void = () => undefined;
  let resolveMessage: () => void = () => undefined;
  let rejectMessage: (error: unknown) => void = () => undefined;
  const apiResult = new Promise((resolve) => { resolveApiResult = resolve; });
  const messagePromise = new Promise<void>((resolve, reject) => {
    resolveMessage = resolve;
    rejectMessage = reject;
  }) as Promise<void> & {resolve: () => void, reject: (error: unknown) => void};
  messagePromise.resolve = resolveMessage;
  messagePromise.reject = rejectMessage;

  const quietLog: (...args: any[]) => void = Object.assign((..._args: any[]): void => undefined, {warn: vi.fn()});
  const apiUpdatesManager = new ApiUpdatesManager() as any;
  apiUpdatesManager.log = Object.assign((..._args: any[]): void => undefined, {bindPrefix: (): typeof quietLog => quietLog});
  apiUpdatesManager.appUsersManager = {
    hasUser: () => true,
    saveApiUsers: vi.fn()
  };
  apiUpdatesManager.appChatsManager = {
    hasChat: () => true,
    saveApiChats: vi.fn()
  };
  apiUpdatesManager.appPaymentsManager = {getCachedStarsStatus: (): undefined => undefined};
  apiUpdatesManager.appPeersManager = {getPeerId: () => peerId};

  const manager = new AppMessagesManager() as any;
  const dispatchEvent = vi.fn();
  const invokeApiAfter = vi.fn(() => apiResult);
  Object.assign(manager, {
    appPeersManager: {
      getPeerMigratedTo: (): undefined => undefined,
      getPeerId: () => peerId,
      getInputPeerById: () => ({_: 'inputPeerUser'}),
      isChannel: () => false
    },
    apiManager: {invokeApiAfter},
    apiUpdatesManager,
    rootScope: {dispatchEvent},
    pendingByRandomId: {},
    pendingByMessageId: {},
    pendingAfterMsgs: {},
    checkSendOptions: async() => ({config: {message_length_max: 4096}, appConfig: {}}),
    getEphemeralSendContext: (): undefined => undefined,
    getInputEntities: (): any[] => [],
    generateOutgoingMessage: () => ({
      _: 'message',
      random_id: randomId,
      mid: tempId,
      pFlags: {is_outgoing: true},
      promise: messagePromise
    }),
    generateOutgoingWebPage: () => ({}),
    beforeMessageSending: (message: any) => {
      manager.pendingByRandomId[randomId] = {peerId, tempId, storage};
      void message.send();
    },
    onMessagesSendError: vi.fn(),
    getMessageFromStorage: (_storage: unknown, mid: number) => mid === tempId ? tempMessage : undefined,
    getHistoryStorage: () => ({history: {delete: vi.fn()}}),
    updateMessageContextForDeletion: vi.fn(),
    getDialogOnly: (): undefined => undefined,
    deletePendingTopMsg: vi.fn(),
    takeTempFinalizeCallbacks: (): undefined => undefined,
    deleteMessageFromStorage: vi.fn(),
    handleReleasingMessage: vi.fn(),
    onMessageModification: vi.fn()
  });
  apiUpdatesManager.appMessagesManager = manager;
  apiUpdatesManager.addEventListener('updateMessageID', manager.onUpdateMessageId);

  return {
    manager,
    dispatchEvent,
    apiUpdatesManager,
    invokeApiAfter,
    resolveApiResult,
    randomId,
    peerId,
    tempId
  };
}

const sendResult: any = {
  _: 'updates',
  users: [],
  chats: [],
  updates: [
    {_: 'updateMessageID', random_id: '123456789', id: 2},
    {_: 'updateNewMessage', message: {
      _: 'message',
      id: 2,
      pFlags: {out: true},
      from_id: {_: 'peerUser', user_id: 777},
      peer_id: {_: 'peerUser', user_id: 777}
    }}
  ]
};

afterEach(() => {
  const scope = window as any;
  delete scope[TRACE_ENABLED];
  delete scope[TRACE_CHECK_NAME];
  delete scope[TRACE_STATE];
});

describe('real-client text-send acknowledgement trace', () => {
  it('records the send result and applied update order while the diagnostic switch is enabled', async() => {
    setTraceSwitch(true);
    const harness = createSendHarness();
    const sendPromise = harness.manager.sendText({peerId: harness.peerId, text: 'private body'});

    await vi.waitFor(() => expect(harness.invokeApiAfter).toHaveBeenCalledWith(
      'messages.sendMessage',
      expect.objectContaining({random_id: harness.randomId}),
      expect.any(Object)
    ));
    harness.resolveApiResult(sendResult);
    await sendPromise;

    harness.manager.finalizePendingMessage(harness.randomId, {
      _: 'message',
      id: 2,
      mid: 2,
      peerId: harness.peerId,
      pFlags: {is_outgoing: true}
    });

    const records = (window as any)[TRACE_STATE]?.records;
    expect(records).toMatchObject([{
      checkName: 'alice_group_message_message_count',
      pendingEntryFound: true,
      messageSent: {emitted: true, tempId: harness.tempId, serverId: 2},
      events: [
        {kind: 'request', pendingTempId: harness.tempId, peerKind: 'user'},
        {kind: 'send_result', updates: [
          {constructor: 'updateMessageID', messageId: 2, randomIdMatches: true},
          {constructor: 'updateNewMessage', messageId: 2, randomIdMatches: false}
        ]},
        {kind: 'pending_entry', found: true, pendingTempId: harness.tempId},
        {kind: 'message_sent', tempId: harness.tempId, serverId: 2}
      ]
    }]);
    expect(records[0].token).toMatch(/^send-[1-9][0-9]*-[a-f0-9]{8}$/);
    expect(records[0].token).not.toContain(harness.randomId);
    expect(records[0].events.map((event: any) => event.kind)).toEqual([
      'request', 'send_result', 'pending_entry', 'message_sent'
    ]);
    expect(JSON.stringify(records)).not.toContain('private body');
  });

  it('records nothing and keeps sending when the diagnostic switch is disabled', async() => {
    setTraceSwitch(false);
    const harness = createSendHarness();
    const sendPromise = harness.manager.sendText({peerId: harness.peerId, text: 'private body'});

    await vi.waitFor(() => expect(harness.invokeApiAfter).toHaveBeenCalled());
    harness.resolveApiResult(sendResult);
    await sendPromise;

    harness.manager.finalizePendingMessage(harness.randomId, {
      _: 'message',
      id: 2,
      mid: 2,
      peerId: harness.peerId,
      pFlags: {is_outgoing: true}
    });

    expect(harness.invokeApiAfter).toHaveBeenCalledTimes(1);
    expect(harness.dispatchEvent).toHaveBeenCalledWith('message_sent', expect.any(Object));
    expect((window as any)[TRACE_STATE]).toBeUndefined();
  });

  it('keeps pre-result mismatched pushed and difference update IDs in arrival order', async() => {
    setTraceSwitch(true);
    const harness = createSendHarness();
    const sendPromise = harness.manager.sendText({peerId: harness.peerId, text: 'private body'});
    await vi.waitFor(() => expect(harness.invokeApiAfter).toHaveBeenCalled());

    const mismatchedUpdate = {
      _: 'updateMessageID',
      random_id: '987654321',
      id: 2
    };
    harness.apiUpdatesManager.processUpdateMessage({_: 'updateShort', update: mismatchedUpdate}, {}, 'pushed');
    harness.apiUpdatesManager.processUpdateMessage({_: 'updateShort', update: mismatchedUpdate}, {}, 'difference');
    harness.resolveApiResult({
      _: 'updates',
      users: [],
      chats: [],
      updates: [{_: 'updateNewMessage', message: {
        _: 'message',
        id: 2,
        pFlags: {out: true},
        from_id: {_: 'peerUser', user_id: 777},
        peer_id: {_: 'peerUser', user_id: 777}
      }}]
    });
    await sendPromise;

    const [record] = (window as any)[TRACE_STATE].records;
    expect(record.pendingEntryFound).toBeNull();
    expect(record.messageSent.emitted).toBe(false);
    expect(record.events.map((event: any) => event.kind)).toEqual(['request', 'update', 'update', 'send_result']);
    expect(record.events.slice(1, 3)).toMatchObject([
      {source: 'pushed', constructor: 'updateMessageID', messageId: 2, randomIdMatches: false},
      {source: 'difference', constructor: 'updateMessageID', messageId: 2, randomIdMatches: false}
    ]);
  });

  it('includes sanitized Alice and Bob records in the flow report', async() => {
    const rawRecord = {
      token: 'send-1-075e4a1d',
      checkName: 'alice_group_message_message_count',
      pendingEntryFound: true,
      messageSent: {emitted: true, tempId: 1.0001, serverId: 2},
      events: [
        {kind: 'request', atMs: 0, pendingTempId: 1.0001, peerKind: 'chat', text: 'private body'},
        {kind: 'send_result', atMs: 5, updates: [
          {constructor: 'updateMessageID', messageId: 2, randomIdMatches: true, message: 'private body'}
        ]}
      ],
      text: 'private body',
      username: 'private-user'
    };
    const makePage = () => ({evaluate: async() => [rawRecord]});
    const report = await realClientBrowser.captureMessageAcknowledgementTraces(makePage(), makePage());

    expect(report.alice).toMatchObject([{
      checkName: 'alice_group_message_message_count',
      events: [
        {kind: 'request', pendingTempId: 1.0001, peerKind: 'chat'},
        {kind: 'send_result', updates: [{constructor: 'updateMessageID', messageId: 2, randomIdMatches: true}]}
      ]
    }]);
    expect(report.bob).toEqual(report.alice);
    expect(JSON.stringify(report)).not.toContain('private body');
    expect(JSON.stringify(report)).not.toContain('private-user');
  });
});
