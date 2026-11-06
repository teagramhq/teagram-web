import type {ChatSavedPosition} from '@lib/appImManager';
import type {AppDraftsManager} from '@appManagers/appDraftsManager';
import type {State} from '@config/state';
import AppStorage from '@lib/storage';
import {AccountDatabase, getDatabaseState, getOldDatabaseState} from '@config/databases/state';
import {ActiveAccountNumber} from '@lib/accounts/types';
import type {ChatPageSnapshot} from '@lib/chatPageSnapshot';

export default class StateStorage extends AppStorage<{
  chatPositions: {
    [peerId_threadId: string]: ChatSavedPosition
  },
  drafts: AppDraftsManager['drafts']
  chatPageSnapshot?: ChatPageSnapshot
} & State, AccountDatabase> {
  constructor(accountNumber: ActiveAccountNumber | 'old') {
    const db = accountNumber === 'old' ?
      getOldDatabaseState() :
      getDatabaseState(accountNumber);

    super(db, 'session', ['chatPageSnapshot']);
  }
}
