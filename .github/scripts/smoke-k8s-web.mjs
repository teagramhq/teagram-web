const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:8080');

const indexResponse = await fetch(baseUrl);
if(!indexResponse.ok) {
  throw new Error(`web root returned HTTP ${indexResponse.status}`);
}

const html = await indexResponse.text();
const scriptPath = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
  .map((match) => match[1])
  .find((path) => /\.js(?:\?|$)/.test(path));

if(!scriptPath) {
  throw new Error('web root did not reference a JavaScript app bundle');
}

const bundleUrl = new URL(scriptPath, baseUrl);
const bundleResponse = await fetch(bundleUrl);
if(!bundleResponse.ok) {
  throw new Error(`app bundle returned HTTP ${bundleResponse.status}: ${bundleUrl.pathname}`);
}

const contentType = bundleResponse.headers.get('content-type') || '';
if(!contentType.includes('javascript')) {
  throw new Error(`app bundle returned unexpected content type: ${contentType || '(missing)'}`);
}

const bundle = await bundleResponse.arrayBuffer();
if(bundle.byteLength === 0) {
  throw new Error('app bundle response was empty');
}

console.log(`web root and app bundle served successfully: ${bundleUrl.pathname}`);
