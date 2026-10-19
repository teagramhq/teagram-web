const STATIC_IMPORT_SPECIFIER = /(\b(?:import|export)\b[^'"\x60;]*?\bfrom\s*|\bimport\s*)(["'])(\/(?!\/)[^"'\x60]+|\.{1,2}\/[^"'\x60]+)\2/g;
const DYNAMIC_IMPORT_SPECIFIER = /(\bimport\s*\(\s*)(["'\x60])(\/(?!\/)[^"'\x60]+|\.{1,2}\/[^"'\x60]+)\2(\s*\))/g;

function resolvePrivateWorkerSpecifier(specifier: string, base: string) {
  const path = specifier.startsWith('/') ? specifier.slice(1) : specifier;
  const expressionStart = path.indexOf('$' + '{');
  if(expressionStart >= 0) {
    return new URL(path.slice(0, expressionStart), base).href + path.slice(expressionStart);
  }
  return new URL(path, base).href;
}

export function rewritePrivateWorkerImports(source: string, base: string) {
  return source
    .replace(STATIC_IMPORT_SPECIFIER, (_match, prefix: string, quote: string, specifier: string) =>
      prefix + quote + resolvePrivateWorkerSpecifier(specifier, base) + quote
    )
    .replace(DYNAMIC_IMPORT_SPECIFIER, (_match, prefix: string, quote: string, specifier: string, suffix: string) =>
      prefix + quote + resolvePrivateWorkerSpecifier(specifier, base) + quote + suffix
    );
}

export async function createPrivateWorkerBlobURL(url: string | URL, serverId?: string, target?: unknown) {
  const entryUrl = new URL(url + '', location.href).href;
  let source = '';
  if(serverId && target) {
    source += `globalThis.__TEAGRAM_ACTIVE_SERVER_ID__=${JSON.stringify(serverId)};globalThis.__TEAGRAM_ACTIVE_MTPROTO_TARGET__=JSON.parse(${JSON.stringify(JSON.stringify(target))});\n`;
  }
  // A SharedWorker fires `connect` without waiting for top-level await, so hold
  // connections that arrive during the import until the entry has its listener.
  source += 'const pendingConnects=[];const holdConnect=(event)=>pendingConnects.push(event);' +
    'globalThis.addEventListener(\'connect\',holdConnect);' +
    `try{await import(${JSON.stringify(entryUrl)});}finally{globalThis.removeEventListener('connect',holdConnect);}` +
    'for(const event of pendingConnects)globalThis.dispatchEvent(new MessageEvent(\'connect\',{data:event.data,ports:event.ports,source:event.source}));';

  return URL.createObjectURL(new Blob([source], {type: 'application/javascript'}));
}
