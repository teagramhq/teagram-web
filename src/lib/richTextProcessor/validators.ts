// https://github.com/tdlib/td/blob/c95598e5e1493881d31211c1329bdbe4630f6136/td/telegram/misc.cpp#L246
import type {MTAppConfig} from '@/appConfig';

export function isUsernameValid(username: string, appConfig?: Partial<MTAppConfig>) {
  if(!username) return false;
  if(appConfig?.username_min_length !== undefined && username.length < appConfig.username_min_length) return false;
  if(appConfig?.username_max_length !== undefined && username.length > appConfig.username_max_length) return false;
  if(appConfig?.username_pattern !== undefined) {
    try {
      if(!new RegExp(appConfig.username_pattern).test(username)) return false;
    } catch{
      // Let the server validate usernames when its configured pattern is malformed.
    }
  }

  return true;
}

export function isWebAppNameValid(name: string) {
  if(name.length < 3 || name.length > 32) return false;
  if(!/[a-zA-Z]/.test(name.charAt(0))) return false;

  for(let i = 0; i < name.length; i++) {
    const char = name.charAt(i);
    if(!/[a-zA-Z0-9_]/.test(char)) return false;
  }

  if(name.charAt(name.length - 1) === '_') return false;

  for(let i = 1; i < name.length; i++) {
    if(name.charAt(i - 1) === '_' && name.charAt(i) === '_') return false;
  }

  return true;
}
