import type showEmojiTonePicker from '@components/emoticonsDropdown/emojiTonePicker';

/**
 * The tone picker is only needed on a right click, so its code loads on demand. The context menu wants
 * `show` and `cleanup` straight away, so both wait for the load and keep their order. A load that
 * fails is reported once and leaves the menu without a picker.
 */
export default function showLazyTonePicker(
  load: () => Promise<ReturnType<typeof showEmojiTonePicker>>,
  onError: (error: unknown) => void
) {
  const picker = load().catch((error): undefined => {
    onError(error);
    return undefined;
  });

  return {
    show: (menu: HTMLElement) => {
      picker.then((result) => result?.show(menu));
    },
    cleanup: () => {
      picker.then((result) => result?.cleanup());
    }
  };
}
