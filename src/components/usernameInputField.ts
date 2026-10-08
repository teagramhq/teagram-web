import ListenerSetter from '@helpers/listenerSetter';
import debounce from '@helpers/schedulers/debounce';
import {LangPackKey} from '@lib/langPack';
import InputField, {InputFieldOptions, InputState} from '@components/inputField';
import {isUsernameValid} from '@lib/richTextProcessor/validators';
import {AppManagers} from '@lib/managers';

export class UsernameInputField extends InputField {
  private checkUsernamePromise: Promise<any>;
  private checkUsernameDebounced: (username: string) => void;
  private saveError = false;
  public options: InputFieldOptions & {
    peerId?: PeerId,
    listenerSetter: ListenerSetter,
    onChange?: () => void,
    isActive?: () => boolean,
    invalidText: LangPackKey,
    takenText: LangPackKey,
    availableText: LangPackKey,
    head?: string
  };
  public error: ApiError;

  constructor(
    options: UsernameInputField['options'],
    private managers: AppManagers
  ) {
    super(options);

    this.checkUsernameDebounced = debounce(this.checkUsername.bind(this), 150, false, true);

    options.listenerSetter.add(this.input)('input', () => {
      const value = this.getValue();

      this.error = undefined;
      this.saveError = false;
      if(value === this.originalValue || !value.length) {
        this.setState(InputState.Neutral);
        this.options.onChange?.();
        return;
      } else if(!isUsernameValid(value)) {
        this.setError(this.options.invalidText);
      } else {
        this.setState(InputState.Neutral);
      }

      if(this.input.classList.contains('error')) {
        this.options.onChange?.();
        return;
      }

      this.checkUsernameDebounced(value);
    });
  }

  public getValue() {
    let value = this.value;
    if(this.options.head) {
      value = value.slice(this.options.head.length);
      this.setValueSilently(this.options.head + value);
    }

    return value;
  }

  private checkUsername(username: string) {
    if(!this.isActive() || this.saveError || this.checkUsernamePromise) return;

    this.error = undefined;
    let checkPromise: Promise<any>
    if(this.options.peerId) {
      checkPromise = this.managers.appChatsManager.checkUsername(this.options.peerId.toChatId(), username);
    } else {
      checkPromise = this.managers.appUsersManager.checkUsername(username);
    }

    const promise = this.checkUsernamePromise = checkPromise.then((available) => {
      if(!this.isActive() || this.saveError || this.getValue() !== username) return;

      if(available) {
        this.setState(InputState.Valid, this.options.availableText);
      } else {
        this.setError(this.options.takenText);
      }
    }, (err) => {
      if(!this.isActive() || this.saveError || this.getValue() !== username) return;

      this.error = err;
      switch(this.error.type) {
        case 'USERNAME_PURCHASE_AVAILABLE': {
          this.setError(this.options.takenText);
          break;
        }

        case 'USERNAME_INVALID':
        default: {
          this.setError(this.options.invalidText);
          break;
        }
      }
    }).then(() => {
      if(!this.isActive()) return;
      if(this.checkUsernamePromise === promise) {
        this.checkUsernamePromise = undefined;
      }

      if(this.saveError) return;
      this.options.onChange?.();

      const value = this.getValue();
      if(value !== username && this.isValidToChange() && isUsernameValid(value)) {
        this.checkUsername(value);
      }
    });
  };

  public setSaveError(username: string, langKey: LangPackKey) {
    if(!this.isActive() || this.getValue() !== username) return false;

    this.error = undefined;
    this.saveError = true;
    this.setError(langKey);
    return true;
  }

  public hasSaveError() {
    return this.saveError;
  }

  private isActive() {
    return this.options.isActive?.() ?? true;
  }
}
