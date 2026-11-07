import '@/materialize.scss';
import '@/scss/style.scss';
import styles from '@/pages/authFlow.module.scss';
import {mountDesktopTurnstilePage} from '@/pages/desktopTurnstile';

document.getElementById('auth-pages')!.classList.add(styles.host);
document.getElementById('turnstile-scrollable')!.classList.add(styles.scrollable);
document.getElementById('turnstile-top-spacer')!.classList.add(styles.placeholder);
document.getElementById('turnstile-bottom-spacer')!.classList.add(styles.placeholder);
document.getElementById('turnstile-container')!.classList.add(styles.cardsContainer);
document.getElementById('turnstile-card')!.classList.add(styles.card);
document.getElementById('turnstile-title')!.classList.add('media-header__title');
document.getElementById('turnstile-challenge')!.classList.add(styles.turnstileChallenge);
document.getElementById('turnstile-widget')!.classList.add(styles.turnstileWidget);

mountDesktopTurnstilePage();
