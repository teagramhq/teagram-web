import wrapUrl from '@lib/richTextProcessor/wrapUrl';
import setAnchorClickHandler from '@helpers/dom/setAnchorClickHandler';

export default function wrapTelegramUrlToAnchor(url1: string) {
  const {url, onclick} = wrapUrl(url1);
  const element = document.createElement('a');
  (element as HTMLAnchorElement).href = url;
  setAnchorClickHandler(element, onclick);

  return element;
}
