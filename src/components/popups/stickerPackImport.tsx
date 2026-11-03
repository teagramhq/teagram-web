import {createEffect, createMemo, createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import {InputFieldTsx} from '@components/inputFieldTsx';
import type InputField from '@components/inputField';
import PopupElement, {createPopup, useSnitchedPopupContext} from '@components/popups/indexTsx';
import {i18n} from '@lib/langPack';
import type {AppManagers} from '@lib/managers';
import showStickersPopup from '@components/popups/stickers';
import {getStickerSetInputByShortName} from '@lib/appManagers/utils/stickers/getStickerSetInput';
import {createStickerSetShareLink, setStickerSetLinkPrefix} from '@helpers/stickerSetLink';
import {readStickerPackZip, StickerPackType, validateStickerPackFiles, StickerPackRejectedFile} from '@helpers/stickerPackImport';
import styles from './stickerPackImport.module.scss';

const SHORT_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

const getServerErrorText = (error: unknown) => {
  const type = (error as ApiError)?.type || (error as Error)?.message || 'UNKNOWN_ERROR';
  return type.toLowerCase().replace(/_/g, ' ');
};

const rejectionText = (reason: StickerPackRejectedFile['reason']) => {
  switch(reason) {
    case 'too_large': return i18n('Teagram.Import.FileTooLarge');
    case 'too_many': return i18n('Teagram.Import.FileLimitReached');
    case 'unsupported_format': return i18n('Teagram.Import.UnsupportedFormat');
  }
};

const StickerPackImportPopup = () => {
  // The popup context is provided by PopupElement below this component, so it is read through the snitch.
  const {SnitchPopupContext, popupContext} = useSnitchedPopupContext();
  const managers: AppManagers = PopupElement.MANAGERS;
  const [type, setType] = createSignal<StickerPackType>('stickers');
  const [title, setTitle] = createSignal('');
  const [shortName, setShortName] = createSignal('');
  const [shortNameStatus, setShortNameStatus] = createSignal<'idle' | 'invalid' | 'checking' | 'available' | 'taken' | 'error'>('idle');
  const [rightsConfirmed, setRightsConfirmed] = createSignal(false);
  const [source, setSource] = createSignal<'folder' | 'zip'>();
  const [sourceFiles, setSourceFiles] = createSignal<File[]>([]);
  const [sourceRejected, setSourceRejected] = createSignal<StickerPackRejectedFile[]>([]);
  const [archiveError, setArchiveError] = createSignal<'invalid_zip' | 'too_many_entries' | 'archive_too_large' | 'entry_too_large'>();
  const [readingArchive, setReadingArchive] = createSignal(false);
  const [configLoading, setConfigLoading] = createSignal(true);
  const [importModeOff, setImportModeOff] = createSignal(false);
  const [configError, setConfigError] = createSignal(false);
  const [uploading, setUploading] = createSignal(false);
  const [suggesting, setSuggesting] = createSignal(false);
  const [uploadError, setUploadError] = createSignal<string>();
  const [zipInput, setZipInput] = createSignal<HTMLInputElement>();
  const [folderInput, setFolderInput] = createSignal<HTMLInputElement>();
  const validation = createMemo(() => validateStickerPackFiles(sourceFiles(), type()));
  const rejected = createMemo(() => [...sourceRejected(), ...validation().rejected]);
  const disabled = () => uploading() || configLoading() || configError() || importModeOff();

  const loadConfig = async(force = false) => {
    setConfigLoading(true);
    setConfigError(false);
    try {
      const config = await managers.apiManager.getAppConfig(force);
      setImportModeOff(config.sticker_import_mode === 'off');
    } catch(err) {
      setConfigError(true);
    } finally {
      setConfigLoading(false);
    }
  };

  onMount(() => {
    void loadConfig();
  });

  let nameCheckVersion = 0;
  createEffect(() => {
    const name = shortName().trim();
    const version = ++nameCheckVersion;
    if(!name) {
      setShortNameStatus('idle');
      return;
    }
    if(!SHORT_NAME_PATTERN.test(name)) {
      setShortNameStatus('invalid');
      return;
    }

    setShortNameStatus('checking');
    const timeout = window.setTimeout(() => {
      managers.appStickersManager.checkStickerSetShortName(name).then((available) => {
        if(version === nameCheckVersion) setShortNameStatus(available ? 'available' : 'taken');
      }).catch(() => {
        if(version === nameCheckVersion) setShortNameStatus('error');
      });
    }, 350);
    onCleanup(() => {
      window.clearTimeout(timeout);
      nameCheckVersion++;
    });
  });

  const chooseFolder = () => folderInput()?.click();
  const chooseZip = () => zipInput()?.click();

  const onFolderChange = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    setSource('folder');
    setArchiveError(undefined);
    setSourceRejected([]);
    setSourceFiles(Array.from(input.files || []));
    setUploadError(undefined);
    input.value = '';
  };

  const onZipChange = async(event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const archive = input.files?.[0];
    input.value = '';
    if(!archive) return;

    setSource('zip');
    setReadingArchive(true);
    setSourceFiles([]);
    setSourceRejected([]);
    setArchiveError(undefined);
    setUploadError(undefined);
    try {
      const result = await readStickerPackZip(archive);
      setArchiveError(result.error);
      setSourceFiles(result.files);
      setSourceRejected(result.rejected);
    } catch(err) {
      setArchiveError('invalid_zip');
    } finally {
      setReadingArchive(false);
    }
  };

  const suggestShortName = async() => {
    const value = title().trim();
    if(!value) return;
    setSuggesting(true);
    try {
      const suggestion = await managers.appStickersManager.suggestStickerSetShortName(value);
      if(title().trim() === value) setShortName(suggestion);
    } catch(err) {
      setUploadError(i18n('Teagram.Import.SuggestFailed').textContent);
    } finally {
      setSuggesting(false);
    }
  };

  const canImport = () =>
    !disabled() &&
    !readingArchive() &&
    !suggesting() &&
    !archiveError() &&
    !!source() &&
    validation().files.length > 0 &&
    !!title().trim() &&
    shortNameStatus() === 'available' &&
    rightsConfirmed();

  const importPack = async() => {
    if(!canImport()) return;
    setUploading(true);
    setUploadError(undefined);
    try {
      const appConfig = await managers.apiManager.getAppConfig(true);
      if(appConfig.sticker_import_mode === 'off') {
        setImportModeOff(true);
        return;
      }

      const {me_url_prefix: prefix} = await managers.apiManager.getConfig();
      createStickerSetShareLink(prefix, shortName().trim(), type() === 'emoji');
      setStickerSetLinkPrefix(prefix);

      const files = validation().files;
      const finalName = shortName().trim();
      const software = source();
      if(!software) return;
      if(!(await managers.appStickersManager.checkStickerSetShortName(finalName))) {
        setShortNameStatus('taken');
        return;
      }

      await managers.appStickersManager.createStickerSet({
        files,
        title: title().trim(),
        shortName: finalName,
        isEmoji: type() === 'emoji',
        software
      });

      popupContext()?.hide();
      showStickersPopup(getStickerSetInputByShortName(finalName), type() === 'emoji');
    } catch(err) {
      setUploadError(`${i18n('Teagram.Import.Failed')}: ${getServerErrorText(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const nameStatusText = () => {
    switch(shortNameStatus()) {
      case 'invalid': return i18n('Teagram.Import.ShortNameInvalid');
      case 'checking': return i18n('Teagram.Import.CheckingName');
      case 'available': return i18n('Link.Available');
      case 'taken': return i18n('EditProfile.Username.Taken');
      case 'error': return i18n('Teagram.Import.NameCheckFailed');
      default: return '';
    }
  };

  const archiveErrorText = () => {
    switch(archiveError()) {
      case 'invalid_zip': return i18n('Teagram.Import.InvalidZip');
      case 'too_many_entries': return i18n('Teagram.Import.ZipEntryLimit');
      case 'archive_too_large': return i18n('Teagram.Import.ZipTooLarge');
      case 'entry_too_large': return i18n('Teagram.Import.ZipEntryTooLarge');
      default: return '';
    }
  };

  return (
    <PopupElement
      show
      closable
      class={styles.popup}
      containerClass={styles.container}
    >
      <SnitchPopupContext />
      <PopupElement.Header>
        <PopupElement.CloseButton />
        <PopupElement.Title>{i18n('Teagram.Import.Title')}</PopupElement.Title>
      </PopupElement.Header>
      <PopupElement.Body>
        <PopupElement.Scrollable class={styles.body} withBorders="top">
          <Show when={!configLoading()} fallback={<div class={styles.status}>{i18n('Loading')}</div>}>
            <Show when={!configError()} fallback={
              <div class={styles.status} role="alert">
                {i18n('Teagram.Import.ConfigFailed')}
                <button class="btn btn-transparent primary" type="button" onClick={() => void loadConfig(true)}>
                  {i18n('Teagram.Import.TryAgain')}
                </button>
              </div>
            }>
              <Show when={!importModeOff()} fallback={<div class={styles.status} role="status">{i18n('Teagram.Import.Disabled')}</div>}>
                <div class={styles.content}>
                  <fieldset class={styles.typeField} disabled={disabled()}>
                    <legend>{i18n('Teagram.Import.Type')}</legend>
                    <label class={styles.radioOption}>
                      <input type="radio" name="sticker-pack-type" checked={type() === 'stickers'} onChange={() => setType('stickers')} />
                      <span>{i18n('Teagram.Import.Stickers')}</span>
                    </label>
                    <label class={styles.radioOption}>
                      <input type="radio" name="sticker-pack-type" checked={type() === 'emoji'} onChange={() => setType('emoji')} />
                      <span>{i18n('Teagram.Import.Emoji')}</span>
                    </label>
                  </fieldset>

                  <div class={styles.field}>
                    <InputFieldTsx
                      label="Teagram.Import.PackTitle"
                      name="sticker-pack-title"
                      plainText
                      maxLength={64}
                      autocomplete="off"
                      value={title()}
                      onRawInput={setTitle}
                      disabled={disabled()}
                    />
                  </div>

                  <div class={styles.nameField}>
                    <InputFieldTsx
                      label="Teagram.Import.ShortName"
                      name="sticker-pack-short-name"
                      plainText
                      maxLength={64}
                      autocomplete="off"
                      value={shortName()}
                      onRawInput={setShortName}
                      disabled={disabled()}
                      instanceRef={(value: InputField) => {
                        value.input.setAttribute('autocapitalize', 'off');
                        value.input.spellcheck = false;
                      }}
                    />
                    <button class="btn btn-transparent primary" type="button" disabled={disabled() || !title().trim() || suggesting()} onClick={() => void suggestShortName()}>
                      {suggesting() ? i18n('Loading') : i18n('Teagram.Import.Suggest')}
                    </button>
                  </div>
                  <Show when={nameStatusText()}>
                    <div class={styles.hint} role="status">{nameStatusText()}</div>
                  </Show>

                  <div class={styles.fileSection}>
                    <div class={styles.sectionLabel}>{i18n('Teagram.Import.Files')}</div>
                    <div class={styles.fileButtons}>
                      <button class="btn btn-primary btn-color-primary" type="button" onClick={chooseFolder} disabled={disabled() || readingArchive()}>
                        {i18n('Teagram.Import.ChooseFolder')}
                      </button>
                      <button class="btn btn-transparent primary" type="button" onClick={chooseZip} disabled={disabled() || readingArchive()}>
                        {i18n('Teagram.Import.ChooseZip')}
                      </button>
                    </div>
                    <input
                      class={styles.hiddenInput}
                      type="file"
                      multiple
                      onChange={onFolderChange}
                      aria-label={i18n('Teagram.Import.ChooseFolder').textContent}
                      ref={(element) => {
                        element.setAttribute('webkitdirectory', '');
                        element.setAttribute('directory', '');
                        setFolderInput(element);
                      }}
                    />
                    <input
                      ref={setZipInput}
                      class={styles.hiddenInput}
                      type="file"
                      accept=".zip,application/zip"
                      onChange={onZipChange}
                      aria-label={i18n('Teagram.Import.ChooseZip').textContent}
                    />
                    <Show when={readingArchive()}>
                      <div class={styles.hint} role="status">{i18n('Teagram.Import.ReadingZip')}</div>
                    </Show>
                    <Show when={source()}>
                      <div class={styles.hint}>
                        {i18n('Teagram.Import.FilesSelected', [validation().files.length, source() === 'zip' ? i18n('Teagram.Import.Zip') : i18n('Teagram.Import.Folder')])}
                      </div>
                    </Show>
                    <Show when={archiveError()}>
                      <div class={styles.error} role="alert">{archiveErrorText()}</div>
                    </Show>
                    <Show when={rejected().length > 0}>
                      <div class={styles.rejectedList} aria-live="polite">
                        <For each={rejected()}>{(file) => (
                          <div class={styles.rejectedItem}>
                            <span class={styles.rejectedName}>{file.name}</span>
                            <span class={styles.rejectedReason}>{rejectionText(file.reason)}</span>
                          </div>
                        )}</For>
                      </div>
                    </Show>
                  </div>

                  <label class={styles.rightsRow}>
                    <input type="checkbox" checked={rightsConfirmed()} onChange={(event) => setRightsConfirmed(event.currentTarget.checked)} disabled={uploading()} />
                    <span>{i18n('Teagram.Import.Rights')}</span>
                  </label>

                  <Show when={uploadError()}>
                    <div class={styles.error} role="alert">{uploadError()}</div>
                  </Show>
                </div>
              </Show>
            </Show>
          </Show>
        </PopupElement.Scrollable>
      </PopupElement.Body>
      <PopupElement.Footer>
        <PopupElement.FooterButton
          confirm
          disabled={!canImport()}
          callback={importPack}
        >
          {uploading() ? i18n('Teagram.Import.Importing') : i18n('Teagram.Import.Import')}
        </PopupElement.FooterButton>
      </PopupElement.Footer>
    </PopupElement>
  );
};

export default function showStickerPackImportPopup() {
  createPopup(() => <StickerPackImportPopup />);
}
