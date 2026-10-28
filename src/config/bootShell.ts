// The boot shell shows the saved server's check before the app, its theme and its language
// pack load. It reuses the root colours and strings the app last applied in this browser.
const BOOT_SHELL_KEY = 'teagram.boot-shell.v1';

export const BOOT_SHELL_STRINGS = [
  'Teagram.Server.Subtitle',
  'Teagram.Server.Address',
  'Teagram.Server.Placeholder',
  'Teagram.Server.Checking'
] as const;

export type BootShell = {
  night: boolean,
  cssText: string,
  strings: Record<typeof BOOT_SHELL_STRINGS[number], string>
};

function readBootShell(): Partial<BootShell> {
  try {
    const saved = JSON.parse(localStorage.getItem(BOOT_SHELL_KEY) || 'null');
    return saved && typeof saved === 'object' ? saved : {};
  } catch{
    return {};
  }
}

function writeBootShell(changes: Partial<BootShell>) {
  try {
    localStorage.setItem(BOOT_SHELL_KEY, JSON.stringify({...readBootShell(), ...changes}));
  } catch{}
}

export function saveBootShellTheme(night: boolean, cssText: string) {
  writeBootShell({night, cssText});
}

export function saveBootShellStrings(strings: BootShell['strings']) {
  writeBootShell({strings});
}

export function getBootShell(): BootShell | undefined {
  const saved = readBootShell();
  if(typeof saved.cssText !== 'string' || !saved.strings) return;
  if(BOOT_SHELL_STRINGS.some((key) => typeof saved.strings[key] !== 'string')) return;
  return {night: saved.night === true, cssText: saved.cssText, strings: saved.strings};
}
