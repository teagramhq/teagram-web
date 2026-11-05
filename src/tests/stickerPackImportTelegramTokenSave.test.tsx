import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {JSX} from 'solid-js';
import {render} from 'solid-js/web';

const mocks = vi.hoisted(() => ({
  managers: {
    apiManager: {
      getAccountNumber: vi.fn(async() => 1),
      getAppConfig: vi.fn(async() => ({sticker_import_mode: 'on'})),
      getConfig: vi.fn(async() => ({me_url_prefix: 'https://teagram.test/'}))
    },
    appStickersManager: {
      checkStickerSetShortName: vi.fn(async() => true),
      suggestStickerSetShortName: vi.fn(async() => 'telegram_cats'),
      createStickerSet: vi.fn(async() => true)
    }
  } as any,
  createPopup: vi.fn(),
  getSavedTelegramBotToken: vi.fn(async() => undefined),
  removeTelegramBotToken: vi.fn(async() => undefined),
  saveTelegramBotToken: vi.fn(),
  downloadTelegramStickerPack: vi.fn(),
  loggerWarn: vi.fn(),
  dispose: undefined as (() => void) | undefined,
  hide: vi.fn()
}));

vi.mock('@components/popups/indexTsx', () => {
  const PopupElement: any = (props: {children?: JSX.Element}) => <div>{props.children}</div>;
  const Container = (props: {children?: JSX.Element}) => <div>{props.children}</div>;
  PopupElement.Header = Container;
  PopupElement.Title = Container;
  PopupElement.CloseButton = () => <button type="button" aria-label="Close" />;
  PopupElement.Body = Container;
  PopupElement.Scrollable = Container;
  PopupElement.Footer = Container;
  PopupElement.FooterButton = (props: {children?: JSX.Element, disabled?: boolean, callback?: () => unknown}) => (
    <button type="button" disabled={props.disabled} onClick={() => void props.callback?.()}>{props.children}</button>
  );
  PopupElement.MANAGERS = mocks.managers;

  return {
    default: PopupElement,
    createPopup: (factory: () => JSX.Element) => {
      mocks.dispose = render(factory, document.body);
    },
    useSnitchedPopupContext: (): any => ({SnitchPopupContext: (): null => null, popupContext: () => ({hide: mocks.hide})})
  };
});

vi.mock('@components/inputFieldTsx', () => ({
  InputFieldTsx: (props: {name: string, value?: string, disabled?: boolean, onRawInput?: (value: string) => void}) => (
    <input
      name={props.name}
      value={props.value || ''}
      disabled={props.disabled}
      onInput={(event) => props.onRawInput?.(event.currentTarget.value)}
    />
  )
}));
vi.mock('@components/checkboxFieldTsx', () => ({
  default: (props: {checked?: boolean, disabled?: boolean, onChange?: (checked: boolean) => void}) => (
    <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange?.(event.currentTarget.checked)} />
  )
}));
vi.mock('@components/radioFieldTsx', () => ({
  default: (props: {name: string, value: string, checked?: boolean, ariaLabel?: string}) => (
    <input type="radio" name={props.name} value={props.value} checked={props.checked} aria-label={props.ariaLabel} />
  )
}));
vi.mock('@components/rowTsx', () => {
  const Row: any = (props: {children?: JSX.Element}) => <div>{props.children}</div>;
  Row.Title = (props: {children?: JSX.Element}) => <span>{props.children}</span>;
  Row.RadioField = (props: {children?: JSX.Element}) => <span>{props.children}</span>;
  Row.CheckboxField = (props: {children?: JSX.Element}) => <span>{props.children}</span>;
  return {default: Row};
});
vi.mock('@lib/langPack', () => ({
  i18n: (key: string) => document.createTextNode(({
    'Teagram.Import.Title': 'Import a sticker pack',
    'Teagram.Import.PackTitle': 'Pack title',
    'Teagram.Import.ShortName': 'Short name',
    'Teagram.Import.TelegramLink': 'Telegram pack link',
    'Teagram.Import.TelegramToken': 'Telegram bot token',
    'Teagram.Import.TelegramTokenSaveFailed': 'Pack downloaded, but the bot token couldn’t be saved. The pack is ready to import.',
    'Teagram.Import.Telegram': 'Telegram pack',
    'Teagram.Import.FilesSelected': '1 files selected from Telegram pack',
    'Teagram.Import.Files': 'Files',
    'Teagram.Import.DownloadTelegram': 'Download from Telegram',
    'Teagram.Import.Import': 'Import pack',
    'Teagram.Import.Rights': 'I have the right to share this pack.',
    'Link.Available': 'Link is available'
  } as Record<string, string>)[key] || key)
}));
vi.mock('@lib/logger', () => ({
  logger: (): any => Object.assign((): void => undefined, {
    warn: mocks.loggerWarn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    assert: vi.fn(),
    group: vi.fn(),
    groupCollapsed: vi.fn(),
    groupEnd: vi.fn(),
    setPrefix: vi.fn(),
    setLevel: vi.fn(),
    bindPrefix: vi.fn()
  })
}));
vi.mock('@helpers/stickerPackImport', () => ({
  readStickerPackZip: vi.fn(),
  validateStickerPackFiles: (files: File[]) => ({files, rejected: [] as never[]})
}));
vi.mock('@helpers/stickerPackCommon', () => ({SHORT_NAME_PATTERN: /^[A-Za-z0-9_]{1,64}$/}));
vi.mock('@helpers/telegramStickerPackImport', () => ({
  downloadTelegramStickerPack: mocks.downloadTelegramStickerPack,
  getTelegramStickerPackUploadOptions: (pack: any, shortName: string) => ({...pack, shortName, isEmoji: pack.type === 'emoji', software: pack.source}),
  isValidTelegramBotToken: (token: string) => /^\d+:[A-Za-z0-9_-]{30,}$/.test(token),
  parseTelegramStickerPackLink: (value: string) => value === 'https://t.me/addstickers/Cats_2' ? {
    name: 'Cats_2', type: 'stickers', source: 'https://t.me/addstickers/Cats_2'
  } : undefined,
  TelegramStickerPackImportError: class extends Error {}
}));
vi.mock('@helpers/telegramStickerPackTokenStorage', () => ({
  getSavedTelegramBotToken: mocks.getSavedTelegramBotToken,
  removeTelegramBotToken: mocks.removeTelegramBotToken,
  saveTelegramBotToken: mocks.saveTelegramBotToken
}));
vi.mock('@helpers/stickerSetLink', () => ({
  createStickerSetShareLink: vi.fn(),
  setStickerSetLinkPrefix: vi.fn(() => true)
}));
vi.mock('@lib/appManagers/utils/stickers/getStickerSetInput', () => ({
  getStickerSetInputByShortName: (shortName: string) => ({_: 'inputStickerSetShortName', short_name: shortName})
}));
vi.mock('@components/popups/stickers', () => ({default: vi.fn()}));

import showStickerPackImportPopup from '@components/popups/stickerPackImport';

const token = `987654321:${'Z'.repeat(35)}`;

function fill(name: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  return input;
}

beforeEach(() => {
  mocks.managers.apiManager.getAccountNumber.mockResolvedValue(1);
  mocks.managers.apiManager.getAppConfig.mockResolvedValue({sticker_import_mode: 'on'});
  mocks.managers.apiManager.getConfig.mockResolvedValue({me_url_prefix: 'https://teagram.test/'});
  mocks.managers.appStickersManager.checkStickerSetShortName.mockResolvedValue(true);
  mocks.managers.appStickersManager.createStickerSet.mockResolvedValue(true);
  mocks.getSavedTelegramBotToken.mockResolvedValue(undefined);
  mocks.saveTelegramBotToken.mockRejectedValue(new Error('session storage unavailable'));
  mocks.downloadTelegramStickerPack.mockResolvedValue({
    title: 'Telegram Cats',
    type: 'stickers',
    source: 'https://t.me/addstickers/Cats_2',
    files: [new File(['sticker-bytes'], 'sticker-001.webp', {type: 'image/webp'})],
    emojis: ['🐈']
  });
  mocks.managers.appStickersManager.createStickerSet.mockClear();
  mocks.hide.mockClear();
  mocks.loggerWarn.mockClear();
});

afterEach(() => {
  mocks.dispose?.();
  mocks.dispose = undefined;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('Telegram pack token persistence failure', () => {
  it('records saved-token read failures by error name without exposing the message', async() => {
    const failure = new Error(`storage unavailable for ${token}`);
    mocks.getSavedTelegramBotToken.mockRejectedValue(failure);
    showStickerPackImportPopup();

    await vi.waitFor(() => expect(mocks.loggerWarn).toHaveBeenCalledWith('Could not load saved Telegram bot token', 'Error'));

    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(token);
    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Remove saved token')).toBe(false);
  });

  it('keeps the downloaded files available for import and reports the token save failure', async() => {
    showStickerPackImportPopup();
    await vi.waitFor(() => expect(document.querySelector('input[name="telegram-pack-link"]')).not.toBeNull());
    fill('telegram-pack-link', 'https://t.me/addstickers/Cats_2');
    fill('telegram-bot-token', token);
    const downloadButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Download from Telegram')!;
    downloadButton.click();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
    .toBe('Pack downloaded, but the bot token couldn’t be saved. The pack is ready to import.'));

    expect(document.querySelector<HTMLInputElement>('input[name="sticker-pack-title"]')?.value).toBe('Telegram Cats');
    expect(document.querySelector<HTMLInputElement>('input[name="telegram-bot-token"]')?.value).toBe(token);
    expect(document.body.textContent).toContain('1 files selected from Telegram pack');

    fill('sticker-pack-short-name', 'telegram_cats');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Link is available'));
    const rights = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    rights.checked = true;
    rights.dispatchEvent(new Event('change', {bubbles: true}));
    const importButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Import pack')!;
    await vi.waitFor(() => expect(importButton.disabled).toBe(false));
    importButton.click();

    await vi.waitFor(() => expect(mocks.managers.appStickersManager.createStickerSet).toHaveBeenCalledOnce());
    expect(mocks.managers.appStickersManager.createStickerSet.mock.calls[0][0].software).toBe('https://t.me/addstickers/Cats_2');
  });
});
