import {createSignal, onMount, Show} from 'solid-js';
import {PendingSuggestion} from '@components/sidebarLeft/pendingSuggestionItem';
import {DEMO_SERVER_HOST} from '@config/serverSelection';
import {getActiveServerHost, isAutoGuestEnabled} from '@config/serverContext';
import {i18n} from '@lib/langPack';
import {isCurrentAccountGuest} from '@lib/guestAccountLifecycle';
import {markAutoGuestAttempted} from '@lib/autoGuest';
import styles from '@components/sidebarLeft/pendingSuggestion.module.scss';

export default function DemoGuestBanner() {
  const [visible, setVisible] = createSignal(false);

  onMount(() => {
    if(!isAutoGuestEnabled() || getActiveServerHost() !== DEMO_SERVER_HOST) return;
    void isCurrentAccountGuest().then((isGuest) => {
      if(!isGuest) return;
      markAutoGuestAttempted();
      setVisible(true);
    }).catch((error) => {
      console.error('Could not verify the current demo guest account', error);
    });
  });

  return (
    <Show when={visible()}>
      <div class={styles.suggestionContainer} role="status">
        <PendingSuggestion class={styles.secondary}>
          <PendingSuggestion.Title>{i18n('Teagram.Demo.Banner.Title')}</PendingSuggestion.Title>
          <PendingSuggestion.Subtitle>
            {i18n('Teagram.Demo.Banner.Description')}{' '}
            <a href="https://web.teagram.io" target="_blank" rel="noopener noreferrer">web.teagram.io</a>
          </PendingSuggestion.Subtitle>
        </PendingSuggestion>
      </div>
    </Show>
  );
}
