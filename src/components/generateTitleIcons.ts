import {attachClickEvent} from '@helpers/dom/clickEvent';
import {Chat, User} from '@layer';
import {i18n} from '@lib/langPack';
import {logger} from '@lib/logger';
import apiManagerProxy from '@lib/apiManagerProxy';
import rootScope from '@lib/rootScope';
import generateFakeIcon from '@components/generateFakeIcon';
import generatePremiumIcon from '@components/generatePremiumIcon';
import generateVerifiedIcon from '@components/generateVerifiedIcon';
import PopupElement from '@components/popups';
import PopupPremium from '@components/popups/premium';
import PopupStarGiftInfo from '@components/popups/starGiftInfo';
import {openEmojiStatusPickerSafely} from '@components/sidebarLeft/emojiStatus';
import {wrapAdaptiveCustomEmoji} from '@components/wrappers/customEmojiSimple';
import {handleFireAndForgetStickerError} from '@components/wrappers/sticker';
import wrapEmojiStatus from '@components/wrappers/emojiStatus';

const log = logger('GenerateTitleIcons');

export default async function generateTitleIcons({
  peerId,
  noVerifiedIcon,
  noBotVerifiedIcon,
  noFakeIcon,
  noPremiumIcon,
  noDirectMessagesBadge,
  peer,
  wrapOptions,
  clickableEmojiStatus = false
}: {
  peerId: PeerId,
  wrapOptions: WrapSomethingOptions,
  noVerifiedIcon?: boolean,
  noBotVerifiedIcon?: boolean,
  noFakeIcon?: boolean,
  noPremiumIcon?: boolean,
  noDirectMessagesBadge?: boolean,
  clickableEmojiStatus?: boolean,
  peer?: Chat | User
}): Promise<{elements: HTMLElement[]; botVerification?: HTMLElement;}> {
  peer ??= apiManagerProxy.getPeer(peerId);
  const elements: HTMLElement[] = [];
  if(!peer) {
    return {elements};
  }

  if(((peer as Chat.channel).pFlags.fake || (peer as User.user).pFlags.scam) && !noFakeIcon) {
    elements.push(generateFakeIcon((peer as User.user).pFlags.scam));
  }

  if(!noPremiumIcon && wrapOptions?.middleware) {
    const emojiStatus = (peer as User.user | Chat.channel).emoji_status;
    const isPremiumFeaturesHidden = await apiManagerProxy.isPremiumFeaturesHidden();
    if(emojiStatus && 'document_id' in emojiStatus) {
      const {middleware} = wrapOptions;
      const container = await wrapEmojiStatus({
        emojiStatus,
        wrapOptions
      });

      if(clickableEmojiStatus) {
        container.classList.add('clickable');
        let busy = false;
        const detach = attachClickEvent(container, async(e) => {
          e.stopPropagation();
          if(peerId === rootScope.myId) {
            void openEmojiStatusPickerSafely({
              managers: rootScope.managers,
              anchorElement: container
            }, (error) => log.error('Failed to open emoji status picker', error));
          } else if(emojiStatus._ === 'emojiStatusCollectible') {
            if(busy) return;
            busy = true;
            const gift = await rootScope.managers.appGiftsManager.getGiftBySlug(emojiStatus.slug);
            PopupElement.createPopup(PopupStarGiftInfo, {gift});
            busy = false;
          }
        });

        middleware.onDestroy(detach);
      }

      if(!middleware()) return {elements};
      elements.push(container);
    } else if((peer as User.user).pFlags.premium && !isPremiumFeaturesHidden) {
      const premiumIcon = generatePremiumIcon();

      if(clickableEmojiStatus) {
        premiumIcon.classList.add('clickable');
        const detach = attachClickEvent(premiumIcon, (e) => {
          e.stopPropagation();
          PopupPremium.show({
            peerId
          });
        });

        wrapOptions.middleware.onDestroy(detach);
      }

      elements.push(premiumIcon);
    }
  }

  if((peer as Chat.channel).pFlags.verified && !noVerifiedIcon) {
    elements.push(generateVerifiedIcon());
  }

  if(peer?._ === 'channel' && peer.pFlags?.monoforum && !noDirectMessagesBadge) {
    const span = document.createElement('span');
    span.append(i18n('ChannelDirectMessages.Badge'));
    span.classList.add('peer-title-direct-badge');
    elements.push(span);
  }

  let botVerification: HTMLElement;
  if((peer as User.user | Chat.channel).bot_verification_icon && !noBotVerifiedIcon) {
    const {container, loadPromise} = wrapAdaptiveCustomEmoji({
      docId: (peer as User.user | Chat.channel).bot_verification_icon,
      size: 24,
      wrapOptions
    });
    void loadPromise.catch(handleFireAndForgetStickerError);

    botVerification = container;
    container.classList.add('peer-title-bot-verification');
  }

  return {elements, botVerification};
}
