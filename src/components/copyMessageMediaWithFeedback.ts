import type {MyMessage} from '@appManagers/appMessagesManager';
import getMediaFromMessage from '@appManagers/utils/messages/getMediaFromMessage';
import type {ButtonMenuItemOptions} from '@components/buttonMenu';
import {toastNew} from '@components/toast';
import copyMediaToClipboard from '@helpers/copyMediaToClipboard';
import contextMenuController from '@helpers/contextMenuController';

export default function copyMessageMediaWithFeedback(options: {
  message: MyMessage,
  button: ButtonMenuItemOptions,
  index?: number,
  cleanup?: () => void
}) {
  const {message, button, index, cleanup} = options;
  const media = getMediaFromMessage(message, true, index);
  const buttonElement = button.element;

  void import('@components/buttonMenu').then(({setButtonMenuItemLoading}) => {
    setButtonMenuItemLoading(button, true, buttonElement);

    return copyMediaToClipboard(media).then(() => {
      toastNew({langPackKey: 'MediaCopied'});
      if(buttonElement?.closest('.btn-menu')?.classList.contains('active')) {
        contextMenuController.close();
      }
    }).catch((error) => {
      console.error('media copy failed', error);
      toastNew({langPackKey: 'MediaCopyFailed'});
    }).finally(() => {
      cleanup?.();
      setButtonMenuItemLoading(button, false, buttonElement);
    });
  }).catch((error) => {
    console.error('button menu load failed', error);
    toastNew({langPackKey: 'MediaCopyFailed'});
    cleanup?.();
  });
}
