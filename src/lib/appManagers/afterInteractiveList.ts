import rootScope from '@lib/rootScope';

export default function afterInteractiveList(callback: () => void, eventSource = rootScope) {
  eventSource.addEventListener('chat_list_interactive', () => {
    setTimeout(callback, 100);
  }, {once: true});
}
