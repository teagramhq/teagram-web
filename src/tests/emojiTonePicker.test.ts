import {attachClickEvent, simulateClickEvent} from '@helpers/dom/clickEvent';
import {getEmojiSkinToneVariants} from '@helpers/emojiSkinTone';
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
    const emojiTarget = document.createElement('span');
    emojiTarget.classList.add('super-emoji');
    const emoji = document.createElement('span');
    emoji.textContent = '👋';
    emojiTarget.append(emoji);
    document.body.append(emojiTarget, target);
    const {baseEmoji, variants} = getEmojiSkinToneVariants('👋');
    const composer = document.createElement('textarea');
    composer.value = 'hello world';
    composer.setSelectionRange(6, 6);
    const contextMenuEvent = new MouseEvent('contextmenu', {bubbles: true});
    emojiTarget.dispatchEvent(contextMenuEvent);
    const insertAtCaret = vi.fn((emoji: string) => {
      composer.setRangeText(emoji, composer.selectionStart, composer.selectionEnd, 'end');
    });
    const detachClick = attachClickEvent(emojiTarget, () => insertAtCaret(emoji.textContent));
    const applyEmojiVariant = vi.fn((_baseEmoji: string, tone: number) => {
      emoji.textContent = variants[tone];
    });
    const saveEmojiVariant = vi.fn();
    const close = vi.fn();
    const picker = showEmojiTonePicker({
      event: contextMenuEvent,
      variants,
      selectedTone: 0,
      renderEmoji: (emoji) => {
        const element = document.createElement('span');
        element.textContent = emoji;
        return element;
      },
      onSelect: (tone) => {
        applyEmojiVariant(baseEmoji, tone);
        saveEmojiVariant(baseEmoji, tone);
      },
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

    detachClick();
    picker.cleanup();
    vi.advanceTimersByTime(200);
  });
});
