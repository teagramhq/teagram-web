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
