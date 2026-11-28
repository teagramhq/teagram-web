import {toastNew} from '@components/toast';
import {LangPackKey} from '@lib/langPack';
import {copyTextToClipboard} from '@helpers/clipboard';
import cancelEvent from '@helpers/dom/cancelEvent';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {buildFragmentLinkURL} from '@helpers/fragmentLinkURL';

const T_ME = 'https://t.me/';
export default function anchorCopy(options: Partial<{
  // href: string,
  mePath: string,
  username: string
}> = {}) {
  const anchor = document.createElement('a');
  anchor.classList.add('anchor-copy');

  let copyWhat: string, copyText: LangPackKey = 'LinkCopied';
  if(options.mePath) {
    const href = T_ME + options.mePath;
    copyWhat = anchor.href = anchor.innerText = href;
  }

  if(options.username) {
    void buildFragmentLinkURL({type: 1, username: options.username}).then((href) => anchor.href = href);
    copyWhat = anchor.innerText = '@' + options.username;
    copyText = 'UsernameCopied';
  }

  attachClickEvent(anchor, (e) => {
    cancelEvent(e);
    copyTextToClipboard(copyWhat ?? anchor.href);
    toastNew({langPackKey: copyText});
  });

  return anchor;
}
