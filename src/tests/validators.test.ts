import {isUsernameValid, isWebAppNameValid} from '../lib/richTextProcessor/validators';

describe('isUsernameValid', () => {
  it('uses only username rules supplied by appConfig', () => {
    const appConfig = {
      username_min_length: 2,
      username_max_length: 4,
      username_pattern: '^[a-z][a-z0-9_]{1,3}$'
    };

    expect(isUsernameValid('ab', appConfig)).toBe(true);
    expect(isUsernameValid('a_1b', appConfig)).toBe(true);
    expect(isUsernameValid('a', appConfig)).toBe(false);
    expect(isUsernameValid('abcde', appConfig)).toBe(false);
    expect(isUsernameValid('1a', appConfig)).toBe(false);
    expect(isUsernameValid('a-b', appConfig)).toBe(false);
  });

  it('does not impose missing rules locally', () => {
    expect(isUsernameValid('a')).toBe(true);
    expect(isUsernameValid('A'.repeat(40))).toBe(true);
    expect(isUsernameValid('')).toBe(false);
  });
});

describe('isWebAppNameValid', () => {
  test('validates names used in web app links', () => {
    expect(isWebAppNameValid('myapp')).toBe(true);
    expect(isWebAppNameValid('ab')).toBe(false);
    expect(isWebAppNameValid('app_')).toBe(false);
    expect(isWebAppNameValid('a__b')).toBe(false);
  });
});
