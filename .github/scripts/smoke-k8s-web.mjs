const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:8080');
const expectedSourceCommit = process.argv[3];
const expectedArtifactDigest = process.argv[4];

if((expectedSourceCommit === undefined) !== (expectedArtifactDigest === undefined)) {
  throw new Error('source commit and artifact digest must be provided together');
}
if(expectedSourceCommit !== undefined && !/^[0-9a-f]{40}$/.test(expectedSourceCommit)) {
  throw new Error('source commit must be a full 40-character SHA');
}
if(expectedArtifactDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(expectedArtifactDigest)) {
  throw new Error('artifact digest must be a SHA-256 digest');
}
if(expectedSourceCommit !== undefined) {
  baseUrl.searchParams.set('deploy', expectedSourceCommit);
}

const indexResponse = await fetch(baseUrl, {cache: 'no-store'});
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

if(expectedSourceCommit !== undefined) {
  const targetUrl = new URL(`/mtproto-target.json?deploy=${expectedSourceCommit}`, baseUrl);
  const targetResponse = await fetch(targetUrl, {cache: 'no-store'});
  if(!targetResponse.ok) {
    throw new Error(`artifact manifest returned HTTP ${targetResponse.status}`);
  }

  let target;
  try {
    target = await targetResponse.json();
  } catch {
    throw new Error('artifact manifest is not JSON; the origin is serving the SPA fallback for /mtproto-target.json');
  }
  if(target.sourceCommit !== expectedSourceCommit || target.artifactDigest !== expectedArtifactDigest) {
    throw new Error(`served artifact manifest does not match source ${expectedSourceCommit}`);
  }
}

console.log(`web root and app bundle served successfully: ${bundleUrl.pathname}`);
