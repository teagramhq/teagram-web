import cancelEvent from '@helpers/dom/cancelEvent';
import {getOverlayRoot} from '@helpers/appWindow';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import type {EmojiSkinTone, EmojiSkinToneVariants} from '@helpers/emojiSkinTone';
import {createRoot, For, onCleanup, onMount, Show} from 'solid-js';
import {Portal} from 'solid-js/web';

type EmojiTonePickerProps = {
  variants: EmojiSkinToneVariants,
  selectedTone: EmojiSkinTone,
  renderEmoji: (emoji: string) => HTMLElement,
  onSelect: (tone: EmojiSkinTone) => void,
  close: () => void,
  ref: (element: HTMLDivElement) => void
};

export function selectEmojiTone(options: {
  baseEmoji: string,
  variants: EmojiSkinToneVariants,
  tone: EmojiSkinTone,
  applyEmojiVariant: (baseEmoji: string, tone: EmojiSkinTone) => void,
  saveEmojiVariant: (baseEmoji: string, tone: EmojiSkinTone) => void,
  onEmojiSelected: (emoji: {emoji: string}) => void
}) {
  const {baseEmoji, variants, tone, applyEmojiVariant, saveEmojiVariant, onEmojiSelected} = options;
  applyEmojiVariant(baseEmoji, tone);
  saveEmojiVariant(baseEmoji, tone);
  onEmojiSelected({emoji: variants[tone]});
}

function EmojiTonePickerButton(props: {
  emoji: string,
  tone: EmojiSkinTone,
  selected: boolean,
  renderEmoji: EmojiTonePickerProps['renderEmoji'],
  onSelect: EmojiTonePickerProps['onSelect'],
  close: EmojiTonePickerProps['close']
}) {
  let button: HTMLButtonElement;
  const emojiElement = props.renderEmoji(props.emoji);
  emojiElement.classList.add('emoji-tone-picker-emoji');

  onMount(() => {
    const detachClickEvent = attachClickEvent(button, (event) => {
      cancelEvent(event);
      props.onSelect(props.tone);
      props.close();
    });
    onCleanup(detachClickEvent);
  });

  return (
    <button
      ref={button}
      class="btn-icon emoji-tone-picker-button"
      classList={{active: props.selected}}
      type="button"
      aria-label={props.emoji}
      aria-pressed={props.selected}
    >
      {emojiElement}
    </button>
  );
}

function EmojiTonePicker(props: EmojiTonePickerProps) {
  return (
    <div
      ref={props.ref}
      class="markup-tooltip emoji-tone-picker z-depth-1 no-transition"
    >
      <div class="markup-tooltip-wrapper">
        <div class="markup-tooltip-tools markup-tooltip-tools-regular">
          <For each={props.variants}>
            {(emoji, index) => (
              <>
                <Show when={index() === 1}>
                  <span class="markup-tooltip-delimiter" />
                </Show>
                <EmojiTonePickerButton
                  emoji={emoji}
                  tone={index() as EmojiSkinTone}
                  selected={index() === props.selectedTone}
                  renderEmoji={props.renderEmoji}
                  onSelect={props.onSelect}
                  close={props.close}
                />
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

export default function showEmojiTonePicker({
  event,
  variants,
  selectedTone,
  renderEmoji,
  onSelect,
  close
}: {
  event: MouseEvent | TouchEvent,
  variants: EmojiSkinToneVariants,
  selectedTone: EmojiSkinTone,
  renderEmoji: (emoji: string) => HTMLElement,
  onSelect: (tone: EmojiSkinTone) => void,
  close: () => void
}) {
  cancelEvent(event);

  const overlayRoot = getOverlayRoot();
  const doc = overlayRoot.ownerDocument;
  let container: HTMLDivElement;
  const dispose = createRoot((dispose) => {
    <Portal mount={overlayRoot}>
      <EmojiTonePicker
        variants={variants}
        selectedTone={selectedTone}
        renderEmoji={renderEmoji}
        onSelect={onSelect}
        close={close}
        ref={(element) => container = element}
      />
    </Portal>;

    return dispose;
  });
  let cleanupTimeout: number;

  return {
    show: (target: HTMLElement) => {
      const overlayRect = overlayRoot.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const menuRect = container.getBoundingClientRect();
      const viewWidth = overlayRect.width || doc.defaultView.innerWidth;
      const viewHeight = overlayRect.height || doc.defaultView.innerHeight;
      const margin = 8;
      const left = Math.min(Math.max(
        targetRect.left - overlayRect.left + (targetRect.width - menuRect.width) / 2,
        margin
      ), Math.max(margin, viewWidth - menuRect.width - margin));
      const above = targetRect.top - overlayRect.top - menuRect.height - margin;
      const below = targetRect.bottom - overlayRect.top + margin;
      const top = above >= margin ?
        above :
        Math.min(Math.max(below, margin), Math.max(margin, viewHeight - menuRect.height - margin));

      container.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      void container.offsetLeft;
      container.classList.remove('no-transition');
      container.classList.add('is-visible');
    },
    cleanup: () => {
      if(cleanupTimeout) {
        return;
      }

      container.classList.remove('is-visible');
      cleanupTimeout = doc.defaultView.setTimeout(() => {
        dispose();
      }, 200);
    }
  };
}
