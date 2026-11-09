import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const smokeScript = fileURLToPath(new URL('./smoke-k8s-web.mjs', import.meta.url));
const sourceCommit = '1'.repeat(40);
const artifactDigest = `sha256:${'2'.repeat(64)}`;

async function withOrigin(manifestBody, callback) {
  const server = createServer((request, response) => {
    if(request.url?.startsWith('/mtproto-target.json')) {
      response.writeHead(200, {'content-type': manifestBody === '<html>fallback</html>' ? 'text/html' : 'application/json'});
      response.end(manifestBody);
      return;
    }
    if(request.url?.startsWith('/app.js')) {
      response.writeHead(200, {'content-type': 'text/javascript'});
      response.end('window.app = true;');
      return;
    }
    response.writeHead(200, {'content-type': 'text/html'});
    response.end('<script src="/app.js"></script>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await callback(`http://127.0.0.1:${address.port}/`);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}

async function runSmoke(url) {
  const child = spawn(process.execPath, [smokeScript, url, sourceCommit, artifactDigest]);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => stdout += chunk);
  child.stderr.setEncoding('utf8').on('data', (chunk) => stderr += chunk);
  const [status, signal] = await once(child, 'close');
  return {status, signal, stdout, stderr};
}

test('rejects an artifact manifest that serves a different digest', async () => {
  const wrongManifest = JSON.stringify({sourceCommit, artifactDigest: `sha256:${'3'.repeat(64)}`});
  await withOrigin(wrongManifest, async (url) => {
    const result = await runSmoke(url);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /served artifact manifest does not match source/);
  });
});

test('explains when the origin serves the SPA fallback for the artifact manifest', async () => {
  await withOrigin('<html>fallback</html>', async (url) => {
    const result = await runSmoke(url);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /artifact manifest is not JSON; the origin is serving the SPA fallback for \/mtproto-target\.json/);
  });
});
