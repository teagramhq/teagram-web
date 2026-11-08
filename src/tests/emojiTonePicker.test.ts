import {simulateClickEvent} from '@helpers/dom/clickEvent';
import {getEmojiSkinToneVariants} from '@helpers/emojiSkinTone';
import selectEmojiTone from '@components/emoticonsDropdown/selectEmojiTone';
import showEmojiTonePicker from '@components/emoticonsDropdown/emojiTonePicker';

describe('emoji tone picker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  test('renders with Solid, selects a tone and disposes its portal', () => {
    const target = document.createElement('button');
    document.body.append(target);
    const variants = getEmojiSkinToneVariants('👍').variants;
    const onSelect = vi.fn();
    const close = vi.fn();
    const picker = showEmojiTonePicker({
      event: new MouseEvent('contextmenu'),
      variants,
      selectedTone: 3,
      renderEmoji: (emoji) => {
        const element = document.createElement('span');
        element.textContent = emoji;
        return element;
      },
      onSelect,
      close
    });

    picker.show(target);

    const container = document.querySelector('.emoji-tone-picker');
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.emoji-tone-picker-button'));
    expect(buttons).toHaveLength(6);
    expect(buttons[3].classList.contains('active')).toBe(true);
    expect(buttons[3].getAttribute('aria-pressed')).toBe('true');

    simulateClickEvent(buttons[4]);
    expect(onSelect).toHaveBeenCalledWith(4);
    expect(close).toHaveBeenCalledOnce();

    picker.cleanup();
    vi.advanceTimersByTime(200);
    expect(document.querySelector('.emoji-tone-picker')).toBeNull();
  });

  test('inserts the chosen tone into the composer once', () => {
    const target = document.createElement('button');
    document.body.append(target);
    const {baseEmoji, variants} = getEmojiSkinToneVariants('👋');
    const composer = document.createElement('textarea');
    composer.value = 'hello world';
    composer.setSelectionRange(6, 6);
    const insertAtCaret = vi.fn((emoji: string) => {
      composer.setRangeText(emoji, composer.selectionStart, composer.selectionEnd, 'end');
    });
    const applyEmojiVariant = vi.fn();
    const saveEmojiVariant = vi.fn();
    const close = vi.fn();
    const picker = showEmojiTonePicker({
      event: new MouseEvent('contextmenu'),
      variants,
      selectedTone: 0,
      renderEmoji: (emoji) => {
        const element = document.createElement('span');
        element.textContent = emoji;
        return element;
      },
      onSelect: (tone) => selectEmojiTone({
        baseEmoji,
        variants,
        tone,
        applyEmojiVariant,
        saveEmojiVariant,
        onEmojiSelected: (emoji) => insertAtCaret(emoji.emoji)
      }),
      close
    });

    picker.show(target);
    const toneButton = document.querySelectorAll<HTMLButtonElement>('.emoji-tone-picker-button')[4];
    simulateClickEvent(toneButton);

    expect(composer.value).toBe('hello 👋🏾world');
    expect(insertAtCaret).toHaveBeenCalledOnce();
    expect(applyEmojiVariant).toHaveBeenCalledWith(baseEmoji, 4);
    expect(saveEmojiVariant).toHaveBeenCalledWith(baseEmoji, 4);
    expect(close).toHaveBeenCalledOnce();

    picker.cleanup();
    vi.advanceTimersByTime(200);
  });
});
