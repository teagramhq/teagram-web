import {createEffect, createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import {hexToRgb, hslaToString, mixColors, rgbaToHsla} from '@helpers/color';
import {formatDate} from '@helpers/date';
import customProperties from '@helpers/dom/customProperties';
import {copyTextToClipboard} from '@helpers/clipboard';
import createListenerSetter from '@helpers/solid/createListenerSetter';
import {wrapLeftDuration} from '@components/wrappers/wrapDuration';
import Button from '@components/buttonTsx';
import CallLogo from '@components/call/callLogo';
import confirmationPopup from '@components/confirmationPopup';
import MediaHeader from '@components/mediaHeader';
import PopupElement, {createPopup, usePopupContext} from '@components/popups/indexTsx';
import {PreloaderTsx} from '@components/putPreloader';
import Section from '@components/section';
import UsernameRow from '@components/usernameRow';
import {toastNew} from '@components/toast';
import {InviteLink} from '@components/sidebarLeft/tabs/inviteLink';
import {i18n} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import tsNow from '@helpers/tsNow';
import {useAppConfig} from '@stores/appState';
import {useSuperTab} from '@components/solidJsTabs/superTabProvider';
import type {AppInviteFriendsTab} from '@components/solidJsTabs';
import {getActiveServerHost} from '@config/serverContext';
import type {TeagramUserInvite, TeagramUserInvites} from '@layer';
import styles from '@components/sidebarLeft/tabs/inviteFriends.module.scss';

type Invite = TeagramUserInvite.teagramUserInvite;
type InviteList = TeagramUserInvites.teagramUserInvites;
type CreateStatus = 'network' | 'quota' | 'tooNew' | 'tooNewLater' | 'closed' | 'off' | 'open';
type CreateLinkResponse = {link: string, expires_at: number};

const WEEK_SECONDS = 7 * 24 * 60 * 60;
let inviteCreatedPopupId = 0;

function getErrorType(error: unknown) {
  return error && typeof error === 'object' && 'type' in error && typeof error.type === 'string' ? error.type : '';
}

function InviteCreatedPopup(props: {link: string, expiresAt: number, onClose: () => void}) {
  const [show, setShow] = createSignal(false);
  const [copiedOrShared, setCopiedOrShared] = createSignal(false);
  const listenerSetter = createListenerSetter();
  const titleId = `invite-created-title-${++inviteCreatedPopupId}`;
  const expiryText = () => formatDate(new Date(props.expiresAt * 1000), {withTime: true, shortMonth: true}).textContent || '';
  const shareTitle = () => i18n('Teagram.Invite.ShareTitle').textContent || '';
  const shareText = () => i18n('Teagram.Invite.ShareText', [expiryText()]).textContent || '';

  let copyButton: HTMLElement;
  const copyLink = async() => {
    try {
      await copyTextToClipboard(props.link);
      setCopiedOrShared(true);
      toastNew({langPackKey: 'LinkCopied'});
    } catch{
      toastNew({langPackKey: 'Error.AnError'});
    }
  };

  const linkBox = new InviteLink({
    listenerSetter,
    url: props.link,
    class: styles.inviteLink,
    button: false
  });
  linkBox.copyLink = () => void copyLink();

  const canShare = () => {
    if(typeof navigator.share !== 'function') return false;
    if(typeof navigator.canShare !== 'function') return true;
    try {
      return navigator.canShare({url: props.link}) !== false;
    } catch{
      return false;
    }
  };

  const shareLink = async() => {
    try {
      await navigator.share({title: shareTitle(), text: shareText(), url: props.link});
      setCopiedOrShared(true);
    } catch(error) {
      if(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return;
      toastNew({langPackKey: 'Error.AnError'});
    }
  };

  const confirmClose = () => {
    if(copiedOrShared()) return;
    let closed: Promise<void>;
    const confirmation = confirmationPopup({
      titleLangKey: 'Teagram.Invite.CloseTitle',
      descriptionLangKey: 'Teagram.Invite.CloseText',
      button: {langKey: 'Close', isDanger: true},
      onPopup: (popup) => {
        closed = new Promise((resolve) => popup.addEventListener('closeAfterTimeout', resolve, {once: true}));
      }
    });
    return confirmation.then(() => closed).catch(() => {
      requestAnimationFrame(() => copyButton?.focus());
      return Promise.reject();
    });
  };

  const PopupDialogFocus = (): null => {
    const popup = usePopupContext();
    const isTopPopup = () => PopupElement.POPUPS[PopupElement.POPUPS.length - 1] === popup;
    const getFocusableElements = () => Array.from(
      popup.element?.querySelectorAll<HTMLElement>('.popup-container a[href], .popup-container button:not(:disabled), .popup-container [tabindex="0"]') || []
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if(event.key !== 'Tab' || !popup.element?.classList.contains('active') || !isTopPopup()) return;
      const focusable = getFocusableElements();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if(!first || !last) return;
      const active = document.activeElement;
      if(event.shiftKey && (active === first || !popup.element.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if(!event.shiftKey && (active === last || !popup.element.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    const keepFocusInside = (event: FocusEvent) => {
      if(!popup.element?.classList.contains('active') || !isTopPopup() || popup.element.contains(event.target as Node)) return;
      copyButton?.focus();
    };

    onMount(() => {
      listenerSetter.add(document.body)('keydown', onKeyDown);
      listenerSetter.add(document.body)('focusin', keepFocusInside);
    });
    createEffect(() => {
      if(!popup.shown()) return;
      requestAnimationFrame(() => copyButton?.focus());
    });
    return null;
  };

  onMount(() => {
    queueMicrotask(() => setShow(true));
  });

  return (
    <PopupElement
      class={styles.popup}
      containerProps={{
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId
      }}
      show={show()}
      closable
      old
      isConfirmationNeededOnClose={confirmClose}
      onClose={props.onClose}
    >
      <PopupDialogFocus />
      <PopupElement.Header class={styles.popupHeader}>
        <PopupElement.CloseButton ariaLabel="Close" />
      </PopupElement.Header>
      <PopupElement.Body class={styles.popupBody}>
        <MediaHeader class={styles.popupMediaHeader}>
          <CallLogo icon="link" />
          <MediaHeader.Title id={titleId}>{i18n('Teagram.Invite.CreatedTitle')}</MediaHeader.Title>
          <MediaHeader.Subtitle secondary>
            {i18n('Teagram.Invite.CreatedText', [expiryText()])}
          </MediaHeader.Subtitle>
        </MediaHeader>
        {linkBox.container}
        <p class={styles.createdNote}>
          <strong>{i18n('Teagram.Invite.CreatedNoteLead')}</strong>{' '}
          {i18n('Teagram.Invite.CreatedNoteRest')}
        </p>
        <div class={styles.popupButtons}>
          <Button
            ref={(element) => copyButton = element}
            text="Teagram.Invite.Copy"
            primaryFilled
            class={styles.popupButton}
            onClick={copyLink}
          />
          <Show when={canShare()}>
            <Button
              text="Teagram.Invite.Share"
              class={`btn-primary btn-secondary btn-primary-transparent primary ${styles.popupButton}`}
              onClick={shareLink}
            />
          </Show>
        </div>
      </PopupElement.Body>
    </PopupElement>
  );
}

function InviteRow(props: {
  invite: Invite,
  isRevoking: boolean,
  canBeRedeemed: boolean,
  onRevoke: () => void
}) {
  const [now, setNow] = createSignal(tsNow(true));
  const isPending = () => props.invite.state === 'pending';
  const timeLeft = () => Math.max(0, props.invite.expires_at - now());
  const isStillActive = () => props.canBeRedeemed && isPending() && timeLeft() > 0;
  const stateKey = () => {
    switch(props.invite.state) {
      case 'pending': return 'Teagram.Invite.Pending';
      case 'used': return 'Teagram.Invite.Used';
      case 'expired': return 'Teagram.Invite.Expired';
      default: return 'Teagram.Invite.Revoked';
    }
  };
  const color = () => {
    switch(props.invite.state) {
      case 'pending': return 'green';
      case 'used': return 'blue';
      case 'expired': return 'red';
      default: return 'archive';
    }
  };
  const subtitle = () => {
    const created = i18n('Privacy.Passkey.Created', [formatDate(new Date(props.invite.created_at * 1000), {withTime: true, shortMonth: true})]);
    return isStillActive() ? [created, ' • ', i18n('Teagram.Invite.Left', [wrapLeftDuration(timeLeft())])] : created;
  };

  let media: HTMLDivElement;
  let ring: SVGCircleElement;
  const setMedia = (element: HTMLDivElement) => {
    media = element;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 51 51');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('usernames-username-icon-svg');
    ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('cx', '25.5');
    ring.setAttribute('cy', '25.5');
    ring.setAttribute('r', '23.5');
    ring.classList.add('usernames-username-icon-circle');
    svg.append(ring);
    media.append(svg);
  };

  createEffect(() => {
    const time = now();
    if(!ring || !isStillActive()) return;
    const duration = Math.max(1, props.invite.expires_at - props.invite.created_at);
    const progress = Math.min(1, Math.max(0, (time - props.invite.created_at) / duration));
    const green = hexToRgb(customProperties.getProperty('green-color'));
    const danger = hexToRgb(customProperties.getProperty('danger-color'));
    const hsla = rgbaToHsla(...mixColors(green, danger, progress));
    hsla.s = Math.max(55, hsla.s);
    ring.style.setProperty('--color', hslaToString(hsla));
    ring.style.strokeDasharray = `${147.65 * (1 - progress)}, 147.65`;
  });

  onMount(() => {
    const interval = window.setInterval(() => setNow(tsNow(true)), 60_000);
    onCleanup(() => window.clearInterval(interval));
  });

  return (
    <UsernameRow
      role={isPending() ? 'button' : undefined}
      tabIndex={isPending() ? 0 : undefined}
      aria-haspopup={isPending() ? 'menu' : undefined}
      clickable={isPending()}
      disabled={props.isRevoking}
      contextMenu={isPending() ? {
        buttons: [{
          icon: 'delete',
          text: 'Teagram.Invite.Revoke',
          danger: true,
          onClick: () => queueMicrotask(props.onRevoke)
        }]
      } : undefined}
      isLink
      icon="limit_link"
      color={color()}
      mediaRef={setMedia}
      title={i18n(stateKey())}
      subtitle={subtitle()}
    />
  );
}

const InviteFriends = () => {
  const [tab] = useSuperTab<typeof AppInviteFriendsTab>();
  const appConfig = useAppConfig();
  const [invites, setInvites] = createSignal<Invite[]>([]);
  const [listState, setListState] = createSignal<'loading' | 'loaded' | 'failed'>('loading');
  const [quota, setQuota] = createSignal(0);
  const [weeklyCount, setWeeklyCount] = createSignal(0);
  const [nextAvailableAt, setNextAvailableAt] = createSignal<number>();
  const [createStatus, setCreateStatus] = createSignal<CreateStatus>();
  const [tooNewAt, setTooNewAt] = createSignal<number>();
  const [creating, setCreating] = createSignal(false);
  const [revokingId, setRevokingId] = createSignal<string>();
  let cancelled = false;
  let createButton: HTMLElement;
  let wasInviteEnabled = !!appConfig.user_invites_enabled;

  createEffect(() => {
    const isEnabled = !!appConfig.user_invites_enabled;
    if(wasInviteEnabled && !isEnabled && !cancelled) {
      tab.close();
      toastNew({langPackKey: 'Teagram.Invite.Off'});
    }
    wasInviteEnabled = isEnabled;
  });

  const left = () => Math.max(0, quota() - weeklyCount());
  const nextDate = () => {
    let timestamp = nextAvailableAt();
    if(!timestamp) {
      const counted = invites().filter((invite) => invite.created_at + WEEK_SECONDS > tsNow(true));
      timestamp = counted.length ? Math.min(...counted.map((invite) => invite.created_at + WEEK_SECONDS)) : tsNow(true) + WEEK_SECONDS;
    }
    return formatDate(new Date(timestamp * 1000), {withTime: true, shortMonth: true});
  };
  const serverStatus = () => {
    if(appConfig.registration_mode === 'closed') return 'closed';
    if(appConfig.registration_mode === 'open') return 'open';
    if(!appConfig.user_invites_enabled) return 'off';
  };
  const captionIsAlert = () => createStatus() === 'network';
  const captionText = () => {
    if(listState() === 'loading' || listState() === 'failed') return i18n('Teagram.Invite.Loading');
    const status = serverStatus();
    if(status === 'closed') return i18n('Teagram.Invite.Closed');
    if(status === 'off') return i18n('Teagram.Invite.Off');
    if(status === 'open') return i18n('Teagram.Invite.Open');
    switch(createStatus()) {
      case 'network':
        return i18n('Teagram.Invite.CreateFailed');
      case 'closed':
        return i18n('Teagram.Invite.Closed');
      case 'off':
        return i18n('Teagram.Invite.Off');
      case 'open':
        return i18n('Teagram.Invite.Open');
      case 'tooNew':
        return tooNewAt() ? i18n('Teagram.Invite.TooNew', [formatDate(new Date(tooNewAt() * 1000), {withTime: true, shortMonth: true})]) : i18n('Teagram.Invite.TooNewLater');
      case 'tooNewLater':
        return i18n('Teagram.Invite.TooNewLater');
      case 'quota':
        return quota() === 1 ? i18n('Teagram.Invite.QuotaReachedOne', [nextDate()]) : i18n('Teagram.Invite.QuotaReached', [quota(), nextDate()]);
    }
    if(left() === 0) return quota() === 1 ? i18n('Teagram.Invite.QuotaReachedOne', [nextDate()]) : i18n('Teagram.Invite.QuotaReached', [quota(), nextDate()]);
    return quota() === 1 ? i18n('Teagram.Invite.QuotaOne') : i18n('Teagram.Invite.Quota', [left(), quota()]);
  };
  const canCreate = () => listState() === 'loaded' && !creating() &&
    !['quota', 'tooNew', 'tooNewLater', 'closed', 'off', 'open'].includes(createStatus() || '') &&
    !serverStatus() && left() > 0;

  const applyInviteList = (result: InviteList) => {
    setInvites(result.invites);
    setQuota(Number(result.quota));
    setWeeklyCount(Number(result.weekly_count));
    setNextAvailableAt(result.next_available_at === undefined ? undefined : Number(result.next_available_at));
  };

  const loadInvites = async(): Promise<InviteList | undefined> => {
    setListState('loading');
    try {
      const result = await rootScope.managers.appAccountManager.listUserInvites();
      if(cancelled) return;
      applyInviteList(result);
      setListState('loaded');
      return result;
    } catch{
      if(!cancelled) setListState('failed');
      return;
    }
  };

  const showCreatedLink = (created: CreateLinkResponse) => {
    createPopup(() => (
      <InviteCreatedPopup
        link={created.link}
        expiresAt={created.expires_at}
        onClose={() => requestAnimationFrame(() => createButton?.focus())}
      />
    ));
  };

  const createInvite = async() => {
    if(!canCreate()) return;
    setCreateStatus(undefined);
    setTooNewAt(undefined);
    setCreating(true);
    try {
      const created = await rootScope.managers.appAccountManager.createUserInvite();
      if(!cancelled) {
        setInvites((current) => [{
          _: 'teagram.userInvite',
          id: created.id,
          state: 'pending',
          created_at: tsNow(true),
          expires_at: created.expires_at
        }, ...current]);
        setWeeklyCount((count) => count + 1);
      }
      showCreatedLink(created);
      if(!cancelled) void loadInvites();
    } catch(error) {
      if(cancelled) return;
      const type = getErrorType(error);
      if(type === 'USER_INVITE_WEEKLY_LIMIT_REACHED') {
        setCreateStatus('quota');
        void loadInvites();
      } else if(type.startsWith('USER_INVITE_ACCOUNT_TOO_NEW_WAIT_')) {
        const wait = Number(type.slice('USER_INVITE_ACCOUNT_TOO_NEW_WAIT_'.length));
        setTooNewAt(Number.isFinite(wait) && wait > 0 ? tsNow(true) + wait : undefined);
        setCreateStatus(Number.isFinite(wait) && wait > 0 ? 'tooNew' : 'tooNewLater');
      } else if(type === 'USER_INVITE_REGISTRATION_CLOSED') {
        setCreateStatus('closed');
      } else if(type === 'USER_INVITES_DISABLED') {
        setCreateStatus('off');
      } else {
        setCreateStatus('network');
      }
    } finally {
      if(!cancelled) setCreating(false);
    }
  };

  const revokeInvite = async(invite: Invite) => {
    try {
      await confirmationPopup({
        titleLangKey: 'Teagram.Invite.RevokeTitle',
        descriptionLangKey: 'Teagram.Invite.RevokeText',
        button: {langKey: 'Teagram.Invite.Revoke', isDanger: true}
      });
    } catch{
      return;
    }

    setRevokingId(String(invite.id));
    try {
      await rootScope.managers.appAccountManager.revokeUserInvite(invite.id);
      const result = await loadInvites();
      if(!result) return;
      const refreshed = result.invites.find((item) => String(item.id) === String(invite.id));
      toastNew({langPackKey: refreshed?.state === 'used' ? 'Teagram.Invite.RevokeUsed' : 'Teagram.Invite.RevokedToast'});
    } catch{
      toastNew({langPackKey: 'Teagram.Invite.RevokeFailed'});
    } finally {
      setRevokingId(undefined);
    }
  };

  onMount(() => {
    if(!appConfig.user_invites_enabled) {
      tab.close();
      toastNew({langPackKey: 'Teagram.Invite.Off'});
      return;
    }
    void loadInvites();
  });

  onCleanup(() => {
    cancelled = true;
  });

  return (
    <div class={styles.container}>
      <Section
        caption={(
          <div aria-live="polite" role={captionIsAlert() ? 'alert' : 'status'}>
            {captionText()}
          </div>
        )}
      >
        <MediaHeader class={styles.header}>
          <CallLogo icon="link" />
          <MediaHeader.Subtitle secondary>
            {i18n('Teagram.Invite.About', [getActiveServerHost()])}
          </MediaHeader.Subtitle>
        </MediaHeader>
        <Button
          ref={(element) => createButton = element}
          text={creating() ? 'Teagram.Invite.Creating' : 'Teagram.Invite.Create'}
          primaryTransparent
          icon={creating() ? undefined : 'add'}
          class={styles.createButton}
          disabled={!canCreate()}
          onClick={createInvite}
        />
      </Section>
      <Section
        class={styles.list}
        name={listState() === 'loaded' && invites().length ? 'Teagram.Invite.List' : undefined}
        caption={listState() === 'loaded' ? 'Teagram.Invite.Footer' : undefined}
      >
        <Show when={listState() === 'loading'}>
          <div class={styles.loading} role="status" aria-live="polite" aria-label={i18n('Teagram.Invite.Loading').textContent}>
            <PreloaderTsx />
          </div>
        </Show>
        <Show when={listState() === 'failed'}>
          <div class={styles.failed} role="status" aria-live="polite">
            <div>{i18n('Teagram.Invite.ListFailed')}</div>
            <Button
              text="Teagram.Invite.TryAgain"
              primaryTransparent
              class={styles.retryButton}
              onClick={() => void loadInvites()}
            />
          </div>
        </Show>
        <Show when={listState() === 'loaded' && invites().length === 0}>
          <div class={styles.empty} role="status" aria-live="polite">
            {i18n('Teagram.Invite.Empty')}
          </div>
        </Show>
        <Show when={listState() === 'loaded' && invites().length > 0}>
          <For each={invites()}>
            {(invite) => (
              <InviteRow
                invite={invite}
                isRevoking={revokingId() === String(invite.id)}
                canBeRedeemed={!serverStatus()}
                onRevoke={() => void revokeInvite(invite)}
              />
            )}
          </For>
        </Show>
      </Section>
    </div>
  );
};

export default InviteFriends;
