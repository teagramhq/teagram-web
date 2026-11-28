import {toastNew} from '@components/toast';
import {INTERNAL_LINK_TYPE} from '@lib/internalLink';
import internalLinkProcessor from '@lib/internalLinkProcessor';
import {encodeBase64Url, toHex, type FragmentLink} from '@lib/fragmentLink';
import {dispatchDefaultServerFragmentLink} from '@lib/fragmentLinkDecode';
import {restorePrivateUsernameV1InviteSecretForRetry} from '@/pages/privateUsernameInviteV1';

function processFragmentLink(link: FragmentLink) {
  switch(link.type) {
    case 1:
      return internalLinkProcessor.processMessageLink({
        _: INTERNAL_LINK_TYPE.MESSAGE,
        domain: link.username
      });
    case 2:
      return internalLinkProcessor.processMessageLink({
        _: INTERNAL_LINK_TYPE.MESSAGE,
        domain: link.username,
        post: link.messageId.toString()
      });
    case 3:
      return internalLinkProcessor.processPrivatePostLink({
        _: INTERNAL_LINK_TYPE.PRIVATE_POST,
        channel: link.channelId.toString(),
        post: link.messageId.toString()
      });
    case 4:
      return internalLinkProcessor.processJoinChatLink({
        _: INTERNAL_LINK_TYPE.JOIN_CHAT,
        invite: encodeBase64Url(link.hash)
      });
    case 5: {
      const secret = toHex(link.secret);
      return import('@/pages/privateUsernameInviteFlow')
      .then(({handleSignedInInviteLink}) => handleSignedInInviteLink(secret, 'v1'))
      .catch(() => {
        toastNew({langPackKey: restorePrivateUsernameV1InviteSecretForRetry(secret) ? 'Teagram.Invite.Retry' : 'Teagram.Invite.RetryUnavailable'});
      });
    }
    case 6:
    case 7:
      return internalLinkProcessor.processStickerSetLink({
        _: link.type === 7 ? INTERNAL_LINK_TYPE.EMOJI_SET : INTERNAL_LINK_TYPE.STICKER_SET,
        set: link.shortName
      });
  }
}

export function openFragmentLink(fragment: string, isDefaultServer: boolean) {
  return dispatchDefaultServerFragmentLink(fragment, processFragmentLink, isDefaultServer);
}
