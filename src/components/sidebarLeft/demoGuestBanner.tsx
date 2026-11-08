import {createSignal, onCleanup, onMount, Show} from 'solid-js';
import {PendingSuggestion} from '@components/sidebarLeft/pendingSuggestionItem';
import {DEMO_SERVER_HOST} from '@config/serverSelection';
import {getActiveServerHost, isAutoGuestEnabled} from '@config/serverContext';
import {i18n} from '@lib/langPack';
import {isCurrentAccountGuest} from '@lib/guestAccountLifecycle';
import {markAutoGuestAttempted} from '@lib/autoGuest';
import rootScope from '@lib/rootScope';
import {getCurrentAccount} from '@lib/accounts/getCurrentAccount';
import {ActiveAccountNumber} from '@lib/accounts/types';
import styles from '@components/sidebarLeft/pendingSuggestion.module.scss';

export default function DemoGuestBanner() {
  const [visible, setVisible] = createSignal(false);

  onMount(() => {
    const checkGuestAccount = (authorizedUserId?: PeerId) => {
      if(!isAutoGuestEnabled() || getActiveServerHost() !== DEMO_SERVER_HOST) {
        setVisible(false);
        return;
      }
      void isCurrentAccountGuest(authorizedUserId).then((isGuest) => {
        setVisible(isGuest);
        if(isGuest) markAutoGuestAttempted();
      }).catch((error) => {
        console.error('Could not verify the current demo guest account', error);
      });
    };
    const onAccountLoggedIn = ({accountNumber, userId}: {accountNumber: ActiveAccountNumber, userId: UserId}) => {
      if(accountNumber === getCurrentAccount()) checkGuestAccount(Number(userId));
    };
    rootScope.addEventListener('account_logged_in', onAccountLoggedIn);
    onCleanup(() => rootScope.removeEventListener('account_logged_in', onAccountLoggedIn));
    checkGuestAccount();
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
