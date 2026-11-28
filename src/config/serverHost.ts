// Kept free of imports so lazy chunks can validate hosts without pulling in server selection.
export function normalizeServerHost(input: string) {
  const value = input.trim();
  if(value.includes(':')) {
    throw new Error('Enter the address without a port');
  }
  if(!value || /[\/?#@\\\s]/.test(value)) {
    throw new Error('Enter a valid server host');
  }

  let url: URL;
  try {
    url = new URL('https://' + value);
  } catch{
    throw new Error('Enter a valid server host');
  }

  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if(host === 'telegram.org' || host.endsWith('.telegram.org')) {
    throw new Error('This server host is not allowed');
  }
  if(!host || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    host.length > 253 || host.split('.').some((label) => !label || label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('Enter a valid server host');
  }
  return host;
}
