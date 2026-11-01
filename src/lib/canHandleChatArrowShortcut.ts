import {ChatType} from '@components/chat/chatType';

export default function canHandleChatArrowShortcut(chat?: {type: ChatType}) {
  return !!chat && chat.type !== ChatType.Scheduled;
}
