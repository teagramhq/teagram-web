import type {PaidReactionPrivacy, Update, Updates} from '@layer';
import {ApiUpdatesManager} from '@appManagers/apiUpdatesManager';
import {AppReactionsManager} from '@appManagers/appReactionsManager';

const privacy: PaidReactionPrivacy = {_: 'paidReactionPrivacyAnonymous'};
const update: Update.updatePaidReactionPrivacy = {
  _: 'updatePaidReactionPrivacy',
  private: privacy
};

const responses: [string, Updates][] = [
  ['updateShort', {_: 'updateShort', update, date: 1}],
  ['updates', {_: 'updates', updates: [update], users: [], chats: [], date: 1, seq: 0}],
  ['updatesCombined', {_: 'updatesCombined', updates: [update], users: [], chats: [], date: 1, seq_start: 0, seq: 0}]
];

describe('AppReactionsManager.getPaidReactionPrivacy', () => {
  it.each(responses)('applies the privacy update from %s', async(_constructor, response) => {
    const manager = new AppReactionsManager();
    const apiUpdatesManager = new ApiUpdatesManager();
    const log = Object.assign(() => {}, {bindPrefix: () => log});
    Object.assign(apiUpdatesManager, {
      appUsersManager: {saveApiUsers: vi.fn()},
      appChatsManager: {saveApiChats: vi.fn()},
      log
    });
    apiUpdatesManager.addEventListener('updatePaidReactionPrivacy', (manager as any).onUpdatePaidReactionPrivacy);
    const processUpdateMessage = vi.spyOn(apiUpdatesManager, 'processUpdateMessage');
    const invokeApiSingleProcess = vi.fn(({processResult}: {processResult?: (result: Updates) => unknown}) => {
      return Promise.resolve(response).then((result) => processResult ? processResult(result) : result);
    });
    Object.assign(manager, {
      apiManager: {invokeApiSingleProcess},
      apiUpdatesManager
    });

    await expect(manager.getPaidReactionPrivacy()).resolves.toEqual(privacy);

    expect(processUpdateMessage).toHaveBeenCalledOnce();
    expect(processUpdateMessage).toHaveBeenCalledWith(response);
    expect(invokeApiSingleProcess).toHaveBeenCalledWith(expect.objectContaining({
      method: 'messages.getPaidReactionPrivacy',
      params: {},
      processResult: expect.any(Function)
    }));
  });
});
