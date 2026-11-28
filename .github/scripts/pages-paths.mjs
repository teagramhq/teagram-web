export const SOURCE_COMMIT_PATH = '.well-known/teagram-web/source-commit.txt';

export const RETIRED_VERSION_PATHS = [
  '.well-known/teagram-web/version.txt',
  '.well-known/telegram-web/version.txt'
];

export const RETIRED_VERSION_URLS = RETIRED_VERSION_PATHS.map((path) => `/${path}`);
