import PopupElement, {addCancelButton, PopupButton} from '@components/popups';
import cancelEvent from '@helpers/dom/cancelEvent';
import type {MessageEntity} from '@layer';
import {FormatterArguments, LangPackKey, i18n} from '@lib/langPack';
import mergeEntities from '@lib/richTextProcessor/mergeEntities';
import parseEntities from '@lib/richTextProcessor/parseEntities';
import wrapRichText from '@lib/richTextProcessor/wrapRichText';

let termsPopupId = 0;

type SimpleConfirmationPopupOptions = {
  titleLangKey: LangPackKey,
  descriptionLangKey?: LangPackKey,
  descriptionText?: string,
  descriptionEntities?: MessageEntity[],
  descriptionArgs?: FormatterArguments,
  buttons: PopupButton[],
  termsDialog?: boolean,
  scrollable?: boolean
};

type SimpleConfirmationPopupShowOptions = Omit<SimpleConfirmationPopupOptions, 'buttons' | 'scrollable'> & {
  button: PopupButton,
  cancelLangKey?: LangPackKey,
  focusReturnTarget?: HTMLElement
};

// ! cant use PopupPeer/confirmationPopup because of awkward recursive dependencies.
// Originally lived in `src/pages/loginPage.ts` next to the `LoginPage` DOM helper;
// extracted here so the legacy `pages/` module tree could be removed in the
// SolidJS auth-flow refactor.
export class SimpleConfirmationPopup extends PopupElement {
  private description: HTMLParagraphElement;
  private acceptButton: PopupButton;
  private declineButton: PopupButton;
  private termsDialog: boolean;

  constructor(options: SimpleConfirmationPopupOptions) {
    const termsDialog = options.termsDialog || false;
    super('popup-peer popup-confirmation' + (termsDialog ? ' popup-terms' : ''), {
      title: options.titleLangKey,
      buttons: options.buttons,
      body: options.scrollable,
      scrollable: options.scrollable
    });

    const description = document.createElement('p');
    description.classList.add('popup-description');
    if(options.descriptionText !== undefined) {
      const disabledEntities = new Set<MessageEntity['_']>([
        'messageEntityBotCommand',
        'messageEntityCashtag',
        'messageEntityHashtag',
        'messageEntityMention',
        'messageEntityMentionName',
        'messageEntityPhone'
      ]);
      const entities = mergeEntities(
        options.descriptionEntities ?? [],
        parseEntities(options.descriptionText).filter((entity) => entity._ === 'messageEntityUrl' || entity._ === 'messageEntityEmail')
      );
      description.append(wrapRichText(options.descriptionText, {
        entities,
        contextSite: 'Teagram',
        disabledEntities
      }));
      description.querySelectorAll('a').forEach((link) => {
        link.removeAttribute('onclick');
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      });
    } else if(options.descriptionLangKey) {
      description.append(i18n(options.descriptionLangKey, options.descriptionArgs));
    }

    if(termsDialog) {
      this.termsDialog = true;
      this.description = description;
      this.description.classList.add('terms-content');
      this.description.tabIndex = 0;
      this.title.id = `simple-confirmation-title-${++termsPopupId}`;
      this.element.setAttribute('role', 'dialog');
      this.element.setAttribute('aria-modal', 'true');
      this.element.setAttribute('aria-labelledby', this.title.id);
      this.acceptButton = options.buttons.find((button) => !button.isCancel);
      this.declineButton = options.buttons.find((button) => button.isCancel);
      this.btnConfirmOnEnter = undefined;
      this.listenerSetter.add(document.body)('keydown', this.onTermsKeyDown);
      this.listenerSetter.add(document.body)('focusin', this.keepFocusInside);
    }

    if(options.scrollable) {
      this.scrollable.container.append(description);
    } else {
      this.header.after(description);
    }
  }

  public show(animate = true) {
    super.show(animate);
    if(!this.termsDialog) return;
    this.navigationItem.onEscape = () => {
      this.declineButton?.element?.click();
      return false;
    };
    this.description.focus();
  }

  private keepFocusInside = (event: FocusEvent) => {
    if(!this.element.classList.contains('active') || this.element.contains(event.target as Node)) return;
    this.description.focus();
  };

  private onTermsKeyDown = (event: KeyboardEvent) => {
    if(!this.element.classList.contains('active')) return;

    if(event.key === 'Tab') {
      const focusable = Array.from(this.container.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex="0"]'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if(!first || !last) return;
      const activeElement = document.activeElement;
      if(event.shiftKey && (activeElement === first || !this.element.contains(activeElement))) {
        cancelEvent(event);
        last.focus();
      } else if(!event.shiftKey && (activeElement === last || !this.element.contains(activeElement))) {
        cancelEvent(event);
        first.focus();
      }
      return;
    }

    if(event.key === 'Enter' && !(event.target as HTMLElement).closest('a, button')) {
      cancelEvent(event);
      this.acceptButton?.element?.click();
    }
  }

  static show(options: SimpleConfirmationPopupShowOptions) {
    return new Promise<void>((resolve, reject) => {
      let resolved = false
      let accepted = false;
      const opener = options.termsDialog ? options.focusReturnTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined) : undefined;

      const buttons = options.termsDialog ? [
        {langKey: options.cancelLangKey || 'Decline', isCancel: true},
        options.button
      ] : addCancelButton([options.button]);
      const cancelButton = buttons.find((button) => button.isCancel);
      cancelButton.callback = () => {
        if(!resolved) {
          reject();
          resolved = true;
        }
      }
      options.button.callback = () => {
        if(!resolved) {
          accepted = true;
          resolve()
          resolved = true;
        }
      }

      const popup = PopupElement.createPopup(SimpleConfirmationPopup, {
        titleLangKey: options.titleLangKey,
        descriptionLangKey: options.descriptionLangKey,
        descriptionText: options.descriptionText,
        descriptionEntities: options.descriptionEntities,
        descriptionArgs: options.descriptionArgs,
        buttons,
        termsDialog: options.termsDialog,
        scrollable: options.termsDialog
      })

      popup.addEventListener('closeAfterTimeout', () => {
        if(!resolved) {
          reject();
          resolved = true;
        }
        if(options.termsDialog && !accepted) opener?.focus();
      })

      popup.show()
    })
  }
}

export default SimpleConfirmationPopup;
