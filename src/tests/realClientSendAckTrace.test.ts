import {afterEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {ApiUpdatesManager} from '@appManagers/apiUpdatesManager';
import {AppMessagesManager} from '@appManagers/appMessagesManager';
import {beginMessageAcknowledgementTrace} from '@appManagers/utils/messages/realClientMessageAckTrace';
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
  const peerId = 777 as PeerId;
  const tempId = 1.0001;
  const selfId = 1 as PeerId;
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
  const invokeApiAfter = vi.fn((..._args: any[]) => apiResult);
  const history = {history: {unshift: vi.fn(), delete: vi.fn()}, maxId: 0};
  Object.assign(manager, {
    appPeersManager: {
      peerId: selfId,
      getPeerMigratedTo: (): undefined => undefined,
      getPeerId: () => peerId,
      getInputPeerById: () => ({_: 'inputPeerUser'}),
      getOutputPeer: (id: PeerId) => ({_: 'peerUser', user_id: id}),
      isAnyChat: () => false,
      isBroadcast: () => false,
      isChannel: () => false,
      isForum: () => false,
      isBotforum: () => false,
      isMonoforum: () => false,
      isMegagroup: () => false,
      canManageDirectMessages: () => false,
      isPeerPublic: () => false
    },
    appChatsManager: {isBroadcast: () => false},
    appUsersManager: {getSelf: () => ({id: selfId}), isBot: () => false},
    appMessagesIdsManager: {
      generateTempMessageId: () => tempId,
      generateMessageId: (id: number) => id
    },
    timeManager: {getServerTimeOffset: () => 0},
    apiManager: {invokeApiAfter},
    apiUpdatesManager,
    rootScope: {dispatchEvent},
    tempMids: {},
    historiesStorage: {},
    messagesStorageByPeerId: {},
    missingMessages: new Set(),
    deletedMessages: new Set(),
    pendingByRandomId: {},
    pendingByMessageId: {},
    pendingAfterMsgs: {},
    checkSendOptions: async() => ({config: {message_length_max: 4096}, appConfig: {}}),
    getEphemeralSendContext: (): undefined => undefined,
    getInputEntities: (): any[] => [],
    generateOutgoingWebPage: () => ({}),
    getMessagePeer: () => peerId,
    getMonoforumThreadId: (): undefined => undefined,
    getHistoryStorage: () => history,
    setMessageToStorage: (storage: Map<number, unknown>, message: {mid: number}) => storage.set(message.mid, message),
    setDialogTopMessage: vi.fn(),
    updateMessageContextForInserting: vi.fn(),
    getMessageFromStorage: (_storage: unknown, mid: number) => mid === tempId ? tempMessage : undefined,
    onMessagesSendError: vi.fn(),
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
    get randomId() { return invokeApiAfter.mock.calls[0]?.[1]?.random_id; },
    peerId,
    tempId
  };
}

function createSendResult(randomId: string): any {
  return {
    _: 'updates',
    users: [],
    chats: [],
    updates: [
      {_: 'updateMessageID', random_id: randomId, id: 2},
      {_: 'updateNewMessage', message: {
        _: 'message',
        id: 2,
        pFlags: {out: true},
        from_id: {_: 'peerUser', user_id: 777},
        peer_id: {_: 'peerUser', user_id: 777}
      }}
    ]
  };
}

afterEach(() => {
  const scope = window as any;
  delete scope[TRACE_ENABLED];
  delete scope[TRACE_CHECK_NAME];
  delete scope[TRACE_STATE];
});

describe('real-client text-send acknowledgement trace', () => {
  it('records the send result and applied update order while the diagnostic switch is enabled', async() => {
    const harness = createSendHarness();
    harness.manager.enableRealClientMessageAckTrace();
    harness.manager.setRealClientMessageAckTraceCheckName('alice_group_message_message_count');
    const sendPromise = harness.manager.sendText({peerId: harness.peerId, text: 'private body'});

    await vi.waitFor(() => expect(harness.invokeApiAfter).toHaveBeenCalledWith(
      'messages.sendMessage',
      expect.objectContaining({random_id: harness.randomId}),
      expect.any(Object)
    ));
    expect(harness.manager.pendingByRandomId[harness.randomId]?.tempId).toBe(harness.tempId);
    expect(harness.manager.getHistoryMessagesStorage(harness.peerId).get(harness.tempId)?.mid).toBe(harness.tempId);
    harness.resolveApiResult(createSendResult(harness.randomId));
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
    expect(harness.manager.getRealClientMessageAckTraceSnapshot()).toMatchObject({
      switchEnabled: true,
      stateExists: true,
      beginCalls: 1,
      rejectedReason: null as string | null,
      beginCallsByCheckName: {alice_group_message_message_count: 1}
    });
    expect(JSON.stringify(records)).not.toContain('private body');
  });

  it('keeps the first pending lookup summary when a duplicate update arrives after send', async() => {
    const harness = createSendHarness();
    harness.manager.enableRealClientMessageAckTrace();
    harness.manager.setRealClientMessageAckTraceCheckName('alice_channel_post_visible');
    const sendPromise = harness.manager.sendText({peerId: harness.peerId, text: 'private body'});

    await vi.waitFor(() => expect(harness.invokeApiAfter).toHaveBeenCalled());
    harness.resolveApiResult(createSendResult(harness.randomId));
    await sendPromise;
    harness.manager.finalizePendingMessage(harness.randomId, {
      _: 'message',
      id: 2,
      mid: 2,
      peerId: harness.peerId,
      pFlags: {is_outgoing: true}
    });

    expect(harness.manager.pendingByRandomId[harness.randomId]).toBeUndefined();
    harness.apiUpdatesManager.processUpdateMessage({
      _: 'updateShort',
      update: {_: 'updateMessageID', random_id: harness.randomId, id: 2}
    }, {}, 'pushed');

    const [record] = (window as any)[TRACE_STATE].records;
    expect(record.pendingEntryFound).toBe(true);
    expect(record.messageSent.emitted).toBe(true);
    expect(record.events.filter((event: any) => event.kind === 'pending_entry').map((event: any) => event.found))
      .toEqual([true, false]);
  });

  it('records nothing and keeps sending when the diagnostic switch is disabled', async() => {
    setTraceSwitch(false);
    const harness = createSendHarness();
    const sendPromise = harness.manager.sendText({peerId: harness.peerId, text: 'private body'});

    await vi.waitFor(() => expect(harness.invokeApiAfter).toHaveBeenCalled());
    harness.resolveApiResult(createSendResult(harness.randomId));
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

  it('reports why an enabled trace attempt was rejected by the ID guard', () => {
    const harness = createSendHarness();
    harness.manager.enableRealClientMessageAckTrace();
    harness.manager.setRealClientMessageAckTraceCheckName('alice_direct_message_count');

    expect(beginMessageAcknowledgementTrace({
      randomId: '123456789',
      pendingTempId: undefined,
      peerKind: 'user',
      peerKey: harness.peerId
    })).toBeUndefined();
    expect(harness.manager.getRealClientMessageAckTraceSnapshot()).toMatchObject({
      switchEnabled: true,
      stateExists: true,
      beginCalls: 1,
      rejectedReason: 'invalid_pending_temp_id',
      beginCallsByCheckName: {alice_direct_message_count: 1},
      records: []
    });
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
    const makePage = () => ({evaluate: async() => ({
      records: [rawRecord],
      switchEnabled: true,
      stateExists: true,
      beginCalls: 1,
      rejectedReason: null as string | null,
      beginCallsByCheckName: {alice_group_message_message_count: 1}
    })});
    const report = await realClientBrowser.captureMessageAcknowledgementTraces(makePage(), makePage());

    expect(report.alice).toMatchObject([{
      checkName: 'alice_group_message_message_count',
      events: [
        {kind: 'request', pendingTempId: 1.0001, peerKind: 'chat'},
        {kind: 'send_result', updates: [{constructor: 'updateMessageID', messageId: 2, randomIdMatches: true}]}
      ]
    }]);
    expect(report.bob).toEqual(report.alice);
    expect(report.diagnostics.alice).toMatchObject({
      switchEnabled: true,
      stateExists: true,
      beginCalls: 1,
      rejectedReason: null
    });
    expect(report.captureErrors).toEqual({});
    expect(JSON.stringify(report)).not.toContain('private body');
    expect(JSON.stringify(report)).not.toContain('private-user');
  });

  it('surfaces trace snapshot evaluation failures instead of treating them as empty captures', async() => {
    const report = await realClientBrowser.captureMessageAcknowledgementTraces({
      evaluate: async() => { throw new Error('private browser detail'); }
    }, {evaluate: async() => ({records: [] as any[], switchEnabled: true, stateExists: true, beginCalls: 0, rejectedReason: null as string | null})});

    expect(report.alice).toEqual([]);
    expect(report.captureErrors.alice).toBe('page_evaluate_failed');
    expect(report.captureErrors.bob).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('private browser detail');
  });

  it('fails a checked send stage when its begin call has no trace record', async() => {
    const page = {evaluate: async() => ({
      records: [] as any[],
      switchEnabled: true,
      stateExists: true,
      beginCalls: 1,
      rejectedReason: null as string | null,
      beginCallsByCheckName: {alice_direct_message_count: 1}
    })};

    await expect(realClientBrowser.assertMessageAckTraceForCheck(
      page,
      'alice_direct_message_count',
      'alice_direct_message_ack_trace'
    )).rejects.toThrow('alice_direct_message_ack_trace');
  });
});
