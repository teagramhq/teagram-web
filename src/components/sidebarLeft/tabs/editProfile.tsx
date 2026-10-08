import {createEffect, createMemo, createResource, createSignal, JSX, on, onCleanup, onMount, Show} from 'solid-js';
import {useSuperTab} from '@components/solidJsTabs/superTabProvider';
import {usePromiseCollector} from '@components/solidJsTabs/promiseCollector';
import {useHotReloadGuard} from '@lib/solidjs/hotReloadGuard';
import {AppChatAutomationTab, type AppEditProfileTab} from '@components/solidJsTabs/tabs';
import Section from '@components/section';
import Row from '@components/rowTsx';
import {InputFieldTsx} from '@components/inputFieldTsx';
import {i18n, LangPackKey} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import getPeerEditableUsername from '@appManagers/utils/peers/getPeerEditableUsername';
import EditPeer from '@components/editPeer';
import InputField from '@components/inputField';
import {UsernameInputField} from '@components/usernameInputField';
import UsernamesSection from '@components/usernamesSection';
import showBirthdayPopup, {saveMyBirthday} from '@components/popups/birthday';
import showPickUserPopup from '@components/popups/pickUser';
import PopupElement from '@components/popups/indexTsx';
import wrapPeerTitle from '@components/wrappers/peerTitle';
import {toastNew} from '@components/toast';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {purchaseUsernameCaption} from '@components/sidebarLeft/tabs/purchaseUsernameCaption';
import {ConnectedBot, User, UserFull} from '@layer';
import {trackAvatarUpload} from '@stores/avatarUpload';

type AppEditProfileTabType = typeof AppEditProfileTab;

export type EditProfileTabPayload = {
  bioMaxLength: MaybePromise<number>,
  user: MaybePromise<User.user>,
  userFull: MaybePromise<UserFull.userFull>,
  connectedBot: MaybePromise<ConnectedBot.connectedBot | undefined>
};

const getUsernameSaveErrorLangKey = (error: unknown): LangPackKey => {
  const type = (error as {type?: string} | null | undefined)?.type;
  switch(type) {
    case 'USERNAME_IMMUTABLE': return 'EditProfile.Username.Immutable';
    case 'USERNAME_OCCUPIED': return 'EditProfile.Username.Taken';
    case 'USERNAME_INVALID': return 'EditProfile.Username.Invalid';
    default: return 'Error.AnError';
  }
};

const EditProfileTab = () => {
  const [tab] = useSuperTab<AppEditProfileTabType>();
  const promiseCollector = usePromiseCollector();
  const {appSidebarLeft} = useHotReloadGuard();

  const payload = tab.payload;
  const loadPromise = Promise.all([
    Promise.resolve(payload.bioMaxLength),
    Promise.resolve(payload.user),
    Promise.resolve(payload.userFull)
  ]);
  promiseCollector.collect(loadPromise);

  const [data] = createResource(() => loadPromise.then(([bioMaxLength, user, userFull]) => ({bioMaxLength, user, userFull})));

  return (
    <Show when={data()}>
      <EditProfileForm data={data()} connectedBot={payload.connectedBot} />
    </Show>
  );
};

export default EditProfileTab;

type FormData = {
  bioMaxLength: number,
  user: User.user,
  userFull: UserFull.userFull
};

const EditProfileForm = (props: {
  data: FormData,
  connectedBot: MaybePromise<ConnectedBot.connectedBot | undefined>
}) => {
  const [tab] = useSuperTab<AppEditProfileTabType>();
  const {user, userFull, bioMaxLength} = props.data;
  const profilePeerId = rootScope.myId;

  tab.container.classList.add('edit-profile-container');

  const inputFields: InputField[] = [];

  const editPeer = new EditPeer({
    peerId: profilePeerId,
    inputFields,
    listenerSetter: tab.listenerSetter,
    middleware: tab.middlewareHelper.get()
  });

  tab.content.append(editPeer.nextBtn);

  let firstNameInputField: InputField;
  let lastNameInputField: InputField;
  let bioInputField: InputField;
  let usernameInputField: UsernameInputField;

  const trackInputField = (field: InputField) => {
    inputFields.push(field);
    tab.listenerSetter.add(field.input)('input', editPeer.handleChange);
  };

  const initialPersonalChannelId: ChatId = userFull.personal_channel_id ?
    userFull.personal_channel_id.toChatId() :
    0;
  const [originalPersonalChannelId, setOriginalPersonalChannelId] = createSignal(initialPersonalChannelId);
  const [personalChannelId, setPersonalChannelId] = createSignal<ChatId>(initialPersonalChannelId);
  const [personalChannelTitle, setPersonalChannelTitle] = createSignal<JSX.Element>(i18n('EditProfile.PersonalChannel.Add'));
  const [hasBirthday, setHasBirthday] = createSignal(!!userFull.birthday);
  const [connectedBot, setConnectedBot] = createSignal<ConnectedBot.connectedBot>();
  const [connectedBotLoaded, setConnectedBotLoaded] = createSignal(false);
  const [connectedBotLoadFailed, setConnectedBotLoadFailed] = createSignal(false);
  const [chatAutomationTitle, setChatAutomationTitle] = createSignal<JSX.Element>(i18n('Loading'));

  let cleanedUp = false;
  let connectedBotVersion = 0;
  onCleanup(() => cleanedUp = true);
  const setConnectedBotFromUpdate = (bot?: ConnectedBot.connectedBot) => {
    if(cleanedUp) return;
    ++connectedBotVersion;
    setConnectedBot(bot);
    setConnectedBotLoadFailed(false);
    setConnectedBotLoaded(true);
  };

  const loadConnectedBot = async(promise: MaybePromise<ConnectedBot.connectedBot | undefined>) => {
    const requestVersion = ++connectedBotVersion;
    setConnectedBotLoadFailed(false);
    setConnectedBotLoaded(false);

    try {
      const bot = await Promise.resolve(promise);
      if(cleanedUp || requestVersion !== connectedBotVersion) {
        return false;
      }

      setConnectedBot(bot);
      setConnectedBotLoaded(true);
      return true;
    } catch{
      if(!cleanedUp && requestVersion === connectedBotVersion) {
        setConnectedBotLoadFailed(true);
      }

      return false;
    }
  };

  loadConnectedBot(props.connectedBot);

  const isPersonalChannelChanged = createMemo(() => personalChannelId() !== originalPersonalChannelId());
  const origIsChanged = editPeer.isChanged;
  editPeer.isChanged = () => origIsChanged() || isPersonalChannelChanged();
  let saveInProgress = false;
  const originalHandleChange = editPeer.handleChange;
  editPeer.handleChange = () => {
    if(cleanedUp) return;
    originalHandleChange();
    if(saveInProgress) {
      editPeer.nextBtn.disabled = true;
    }
  };

  const {setUsername: setPurchaseUsername, element: purchaseEl} = purchaseUsernameCaption();

  let personalChannelTitleVersion = 0;
  createEffect(on(personalChannelId, async(channelId) => {
    const version = ++personalChannelTitleVersion;
    if(channelId) {
      const title = await wrapPeerTitle({peerId: channelId.toPeerId(true)});
      if(!cleanedUp && version === personalChannelTitleVersion) {
        setPersonalChannelTitle(title);
      }
    } else {
      setPersonalChannelTitle(i18n('EditProfile.PersonalChannel.Add'));
    }
  }));

  let chatAutomationTitleVersion = 0;
  createEffect(() => {
    const loaded = connectedBotLoaded();
    const failed = connectedBotLoadFailed();
    const bot = connectedBot();
    const version = ++chatAutomationTitleVersion;
    if(failed) {
      setChatAutomationTitle(i18n('ChatAutomation.LoadFailed'));
    } else if(!loaded) {
      setChatAutomationTitle(i18n('Loading'));
    } else if(!bot) {
      setChatAutomationTitle(i18n('ChatAutomation.Off'));
    } else {
      wrapPeerTitle({peerId: (bot.bot_id as UserId).toPeerId(false)}).then((title) => {
        if(!cleanedUp && version === chatAutomationTitleVersion) setChatAutomationTitle(title);
      });
    }
  });

  tab.listenerSetter.add(rootScope)('chat_automation_update', setConnectedBotFromUpdate);

  const openChatAutomation = async() => {
    if(cleanedUp) return;
    if(connectedBotLoadFailed()) {
      await loadConnectedBot(tab.managers.appBusinessManager.getConnectedBot(true));
      if(cleanedUp) return;
      if(!connectedBotLoaded()) {
        toastNew({langPackKey: 'Error.AnError'});
        return;
      }
    }

    if(!connectedBotLoaded()) {
      return;
    }

    tab.slider.createTab(AppChatAutomationTab).open({connectedBot: connectedBot()});
  };

  const openPersonalChannelPicker = async() => {
    if(cleanedUp) return;
    let channelIds: ChatId[];
    try {
      channelIds = await tab.managers.appProfileManager.getAdminedPersonalChannels();
    } catch(err) {
      if(!cleanedUp) {
        toastNew({langPackKey: 'Error.AnError'});
      }
      return;
    }
    if(cleanedUp) return;

    if(!channelIds.length && !personalChannelId()) {
      toastNew({langPackKey: 'EditProfile.PersonalChannel.NoChannels'});
      return;
    }

    const peerIds = channelIds.map((id) => id.toPeerId(true));

    showPickUserPopup({
      titleLangKey: 'EditProfile.PersonalChannel.PickerTitle',
      peerType: ['custom'],
      getMoreCustom: async() => ({result: peerIds, isEnd: true}),
      noSearch: true,
      onSelect: (chosen) => {
        if(cleanedUp) return;
        const newChatId = chosen[0].peerId.toChatId();
        if(newChatId === personalChannelId()) return;
        setPersonalChannelId(newChatId);
        editPeer.handleChange();
      },
      footer: () => (
        <Show when={personalChannelId()}>
          <PopupElement.FooterButton
            color="danger"
            langKey="EditProfile.PersonalChannel.Remove"
            callback={() => {
              if(cleanedUp) return;
              setPersonalChannelId(0);
              editPeer.handleChange();
            }}
          />
        </Show>
      )
    });
  };

  const onSave = async() => {
    if(cleanedUp || saveInProgress) return;

    saveInProgress = true;
    editPeer.nextBtn.disabled = true;

    const profileValues = {
      firstName: firstNameInputField.value,
      lastName: lastNameInputField.value,
      about: bioInputField.value
    };
    const usernameValue = usernameInputField.value;
    const personalChannelValue = personalChannelId() || undefined;
    const avatarUpload = editPeer.uploadAvatar;
    type WriteKind = 'profile' | 'username' | 'personalChannel' | 'photo';
    const writes: Array<{kind: WriteKind, value?: unknown, promise: Promise<unknown>}> = [];
    const addWrite = (kind: WriteKind, value: unknown, write: () => Promise<unknown> | unknown) => {
      writes.push({kind, value, promise: Promise.resolve().then(write)});
    };

    addWrite('profile', profileValues, () => tab.managers.appProfileManager.updateProfile(
      profileValues.firstName,
      profileValues.lastName,
      profileValues.about
    ));

    if(avatarUpload) {
      const {file: fileFn, video: videoFn, videoStartTs} = avatarUpload;
      addWrite('photo', avatarUpload, async() => {
        const filePromise = fileFn();
        const videoPromise = videoFn?.();
        // Surface the upload to the profile's big avatar (progress ring + cancel +
        // collapse lock) for the duration of the upload.
        trackAvatarUpload(profilePeerId, {file: filePromise, video: videoPromise});
        const uploadResults = await Promise.allSettled([filePromise, videoPromise]);
        const uploadFailure = uploadResults.find((result) => result.status === 'rejected');
        if(uploadFailure?.status === 'rejected') {
          throw uploadFailure.reason;
        }

        const [file, video] = await Promise.all([filePromise, videoPromise]);
        return tab.managers.appProfileManager.uploadProfilePhoto({file, video, videoStartTs});
      });
    }

    if(usernameInputField.isValidToChange()) {
      addWrite('username', usernameValue, () => tab.managers.appUsersManager.updateUsername(usernameValue));
    }

    if(isPersonalChannelChanged()) {
      addWrite('personalChannel', personalChannelValue, () => tab.managers.appProfileManager.updatePersonalChannel(personalChannelValue));
    }

    try {
      const results = await Promise.allSettled(writes.map((write) => write.promise));
      if(cleanedUp) return;

      let hasFailure = false;
      let hasNonUsernameFailure = false;
      results.forEach((result, index) => {
        const write = writes[index];
        if(result.status === 'rejected') {
          hasFailure = true;
          if(write.kind === 'username') {
            usernameInputField.setSaveError(usernameValue, getUsernameSaveErrorLangKey(result.reason));
          } else {
            hasNonUsernameFailure = true;
          }
          return;
        }

        switch(write.kind) {
          case 'profile': {
            firstNameInputField.originalValue = profileValues.firstName;
            lastNameInputField.originalValue = profileValues.lastName;
            bioInputField.originalValue = profileValues.about;
            break;
          }

          case 'username': {
            usernameInputField.originalValue = usernameValue;
            break;
          }

          case 'personalChannel': {
            setOriginalPersonalChannelId((write.value as ChatId | undefined) || 0);
            break;
          }

          case 'photo': {
            if(editPeer.uploadAvatar === write.value) {
              editPeer.uploadAvatar = undefined;
            }
            break;
          }
        }
      });

      editPeer.handleChange();

      if(hasNonUsernameFailure) {
        toastNew({langPackKey: 'Error.AnError'});
      }

      const hasUnsubmittedChanges =
        firstNameInputField.value !== profileValues.firstName ||
        lastNameInputField.value !== profileValues.lastName ||
        bioInputField.value !== profileValues.about ||
        usernameInputField.value !== usernameValue ||
        personalChannelId() !== (personalChannelValue || 0) ||
        !!editPeer.uploadAvatar;
      if(!hasFailure && !usernameInputField.hasSaveError() && !hasUnsubmittedChanges) {
        tab.close();
      }
    } catch{
      if(!cleanedUp) {
        toastNew({langPackKey: 'Error.AnError'});
      }
    } finally {
      saveInProgress = false;
      if(!cleanedUp) {
        editPeer.nextBtn.removeAttribute('disabled');
      }
    }
  };

  attachClickEvent(editPeer.nextBtn, onSave, {listenerSetter: tab.listenerSetter});

  onMount(() => {
    firstNameInputField.setOriginalValue(user.first_name, true);
    lastNameInputField.setOriginalValue(user.last_name, true);
    bioInputField.setOriginalValue(userFull.about, true);
    usernameInputField.setOriginalValue(getPeerEditableUsername(user), true);
    editPeer.handleChange();
  });

  return (
    <>
      {editPeer.avatarEdit.container}

      <Section caption="Bio.Description">
        <div class="input-wrapper">
          <InputFieldTsx
            label="EditProfile.FirstNameLabel"
            name="first-name"
            maxLength={70}
            instanceRef={(ref) => {
              firstNameInputField = ref;
              trackInputField(ref);
            }}
          />
          <InputFieldTsx
            label="Login.Register.LastName.Placeholder"
            name="last-name"
            maxLength={64}
            instanceRef={(ref) => {
              lastNameInputField = ref;
              trackInputField(ref);
            }}
          />
          <InputFieldTsx
            label="EditProfile.BioLabel"
            name="bio"
            maxLength={bioMaxLength}
            instanceRef={(ref) => {
              bioInputField = ref;
              trackInputField(ref);
            }}
          />
        </div>
        <Show when={!hasBirthday()}>
          <Row clickable={() => {
            showBirthdayPopup({
            onSave: async(date) => {
              if(await saveMyBirthday(date)) {
                if(cleanedUp) return true;
                setHasBirthday(true);
                  return true;
                }
                return false;
              }
            });
          }}>
            <Row.Icon icon="gift_filled" />
            <Row.Title>{i18n('EditProfile.AddBirthdayRow')}</Row.Title>
          </Row>
        </Show>
      </Section>

      <UsernameSection
        user={user}
        editPeer={editPeer}
        purchaseEl={purchaseEl}
        onPurchaseUsernameChange={setPurchaseUsername}
        isActive={() => !cleanedUp}
        usernameInputFieldRef={(ref) => {
          usernameInputField = ref;
          trackInputField(ref);
        }}
      />

      <UsernamesSection
        peerId={profilePeerId}
        peer={user}
        usernameInputField={usernameInputField}
      />

      <Section
        name="EditProfile.PersonalChannel.Title"
        caption="EditProfile.PersonalChannel.Description"
      >
        <Row clickable={openPersonalChannelPicker}>
          <Row.Icon icon="newchannel_filled" />
          <Row.Title titleRight={!personalChannelId() && <span class="primary">{personalChannelTitle()}</span>}>
            {personalChannelId() ? personalChannelTitle() : i18n('EditProfile.PersonalChannel.Label')}
          </Row.Title>
        </Row>
      </Section>

      <Section
        name="ChatAutomation.Title"
        caption="ChatAutomation.ProfileDescription"
      >
        <Row
          disabled={!connectedBotLoaded() && !connectedBotLoadFailed()}
          clickable={openChatAutomation}
        >
          <Row.Icon icon="bot_filled" />
          <Row.Title titleRight={!connectedBot() && <span class="primary">{chatAutomationTitle()}</span>}>
            {connectedBot() ? chatAutomationTitle() : i18n('ChatAutomation.ProfileLabel')}
          </Row.Title>
        </Row>
      </Section>
    </>
  );
};

const UsernameSection = (props: {
  user: User.user,
  editPeer: EditPeer,
  purchaseEl: HTMLElement,
  onPurchaseUsernameChange: (username: string) => void,
  isActive: () => boolean,
  usernameInputFieldRef: (ref: UsernameInputField) => void
}) => {
  const [tab] = useSuperTab<AppEditProfileTabType>();

  const onChange = () => {
    props.editPeer.handleChange();
    const error = inputField.error;
    const isPurchase = error?.type === 'USERNAME_PURCHASE_AVAILABLE';
    props.onPurchaseUsernameChange(isPurchase ? inputField.value : undefined);
  };

  const inputField = new UsernameInputField({
    label: 'EditProfile.Username.Label',
    name: 'username',
    plainText: true,
    listenerSetter: tab.listenerSetter,
    onChange,
    isActive: props.isActive,
    availableText: 'EditProfile.Username.Available',
    takenText: 'EditProfile.Username.Taken',
    invalidText: 'EditProfile.Username.Invalid'
  }, tab.managers);

  props.usernameInputFieldRef(inputField);

  const captionContent = (() => {
    const fragment = document.createDocumentFragment();
    fragment.append(props.purchaseEl, i18n('UsernameHelp'));
    return fragment;
  })();

  return (
    <Section
      name="EditAccount.Username"
      caption={captionContent}
    >
      <div class="input-wrapper">
        {inputField.container}
      </div>
    </Section>
  );
};
