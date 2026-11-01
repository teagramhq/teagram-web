import apiManagerProxy from '@lib/apiManagerProxy';
import {ForumTab} from '@components/forumTab/forumTab';


export function fillForumTabRegister() {
  ForumTab.register.addEntry({
    check: (peerId) => {
      const peer = apiManagerProxy.getPeer(peerId);
      return !!(peer?._ === 'channel' && peer?.pFlags?.forum);
    },
    load: async() => (await import('@components/forumTab/groupForumTab')).GroupForumTab
  });

  ForumTab.register.addEntry({
    check: (peerId) => {
      const peer = apiManagerProxy.getPeer(peerId);
      return !!(peer?._ === 'channel' && peer?.pFlags?.monoforum);
    },
    load: async() => (await import('@components/forumTab/monoforumTab')).MonoforumTab
  });

  ForumTab.register.addEntry({
    check: (peerId) => {
      const peer = apiManagerProxy.getPeer(peerId);
      return !!(peer?._ === 'user' && peer?.pFlags?.bot_forum_view);
    },
    load: async() => (await import('@components/forumTab/botforumTab')).BotforumTab
  });
}
