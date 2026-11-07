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
