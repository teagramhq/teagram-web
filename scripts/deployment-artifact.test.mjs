import {execFileSync} from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {assertCleanSourceTree} from './build-deployment-artifact.mjs';
import {
  computePrivateArtifactDigest,
  privateContentSecurityPolicy,
  writePrivateArtifactManifest
} from './private-artifact.mjs';
import {loadReviewedPrivateTarget} from './private-artifact-release.mjs';
import {verifyDeploymentArtifact} from './verify-deployment-artifact.mjs';

const repositoryRoot = resolve('.');
const temporaryDirectories = [];
let validArtifact;
let expectedCommit;
let reviewedTarget;
let target;

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'teagram-deployment-artifact-'));
  temporaryDirectories.push(directory);
  return directory;
}

function artifactCopy() {
  const directory = join(temporaryDirectory(), 'artifact');
  cpSync(validArtifact, directory, {recursive: true});
  return directory;
}

function updateManifest(directory, updates = {}) {
  const manifestPath = join(directory, 'mtproto-target.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  Object.assign(manifest, updates);
  if(updates.updateDigest) {
    delete manifest.updateDigest;
    manifest.artifactDigest = computePrivateArtifactDigest(directory);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

beforeAll(() => {
  const directory = temporaryDirectory();
  validArtifact = join(directory, 'artifact');
  mkdirSync(validArtifact);
  ({reviewed: reviewedTarget, target} = loadReviewedPrivateTarget({rootDirectory: repositoryRoot}));
  expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  }).trim();
  writeFileSync(join(validArtifact, 'index.html'), [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${privateContentSecurityPolicy(target.endpoint)}">`,
    '</head><body><script type="module" src="index.js"></script></body></html>'
  ].join(''));
  writeFileSync(join(validArtifact, 'index.js'), [
    `const endpoint = ${JSON.stringify(target.endpoint)};`,
    `const fingerprint = ${JSON.stringify(target.fingerprint)};`,
    "const signIn = 'Sign in with your username';"
  ].join('\n'));
  writePrivateArtifactManifest(validArtifact, target, repositoryRoot);
});

afterAll(() => {
  for(const directory of temporaryDirectories) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe('deployment artifact verification', () => {
  it('only records HEAD as the source commit when the build tree is clean', () => {
    const rootDirectory = temporaryDirectory();
    execFileSync('git', ['init', '--quiet'], {cwd: rootDirectory});
    expect(() => assertCleanSourceTree(rootDirectory)).not.toThrow();

    const sourcePath = join(rootDirectory, 'untracked.js');
    writeFileSync(sourcePath, 'export const value = 1;\n');
    expect(() => assertCleanSourceTree(rootDirectory)).toThrow(/clean source tree/i);
    unlinkSync(sourcePath);
    expect(() => assertCleanSourceTree(rootDirectory)).not.toThrow();
  });

  it('accepts the intact artifact for the reviewed endpoint, key, and commit', () => {
    const result = verifyDeploymentArtifact({
      directory: validArtifact,
      expectedCommit,
      rootDirectory: repositoryRoot
    });

    expect(result.target.endpoint).toBe('wss://telegram-server.tailaa4918.ts.net/apiws');
    expect(result.target.fingerprint).toBe('fbb62871f07fae2a');
    expect(result.manifest.sourceCommit).toBe(expectedCommit);
  });

  it('rejects an absent or stock-mode manifest', () => {
    const directory = artifactCopy();
    const manifestPath = join(directory, 'mtproto-target.json');

    unlinkSync(manifestPath);
    expect(() => verifyDeploymentArtifact({directory, expectedCommit, rootDirectory: repositoryRoot}))
    .toThrow(/manifest is missing/i);

    writeFileSync(manifestPath, JSON.stringify({mode: 'telegram'}));
    expect(() => verifyDeploymentArtifact({directory, expectedCommit, rootDirectory: repositoryRoot}))
    .toThrow(/manifest fields are incomplete or unexpected/i);

    const stockModeDirectory = artifactCopy();
    updateManifest(stockModeDirectory, {mode: 'telegram'});
    expect(() => verifyDeploymentArtifact({
      directory: stockModeDirectory,
      expectedCommit,
      rootDirectory: repositoryRoot
    })).toThrow(/manifest mode is not private/i);
  });

  it('rejects an artifact bound to a different endpoint or fingerprint', () => {
    const endpointDirectory = artifactCopy();
    updateManifest(endpointDirectory, {endpoint: 'wss://other.example.test/apiws'});
    expect(() => verifyDeploymentArtifact({
      directory: endpointDirectory,
      expectedCommit,
      rootDirectory: repositoryRoot
    })).toThrow(/manifest does not match the validated target/i);

    const fingerprintDirectory = artifactCopy();
    updateManifest(fingerprintDirectory, {fingerprint: 'c3b42b026ce86b21'});
    expect(() => verifyDeploymentArtifact({
      directory: fingerprintDirectory,
      expectedCommit,
      rootDirectory: repositoryRoot
    })).toThrow(/manifest does not match the validated target/i);
  });

  it('rejects a reviewed public key whose bytes no longer match its attested hash', () => {
    const rootDirectory = temporaryDirectory();
    cpSync(join(repositoryRoot, 'ci'), join(rootDirectory, 'ci'), {recursive: true});
    writeFileSync(join(rootDirectory, reviewedTarget.MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE), 'changed public key');

    expect(() => verifyDeploymentArtifact({
      directory: validArtifact,
      expectedCommit,
      rootDirectory
    })).toThrow(/public-key file digest does not match the attestation/i);
  });

  it('rejects a modified chunk with a stale artifact digest', () => {
    const directory = artifactCopy();
    writeFileSync(join(directory, 'index.js'), readFileSync(join(directory, 'index.js'), 'utf8') + '\n// modified');

    expect(() => verifyDeploymentArtifact({directory, expectedCommit, rootDirectory: repositoryRoot}))
    .toThrow(/digest does not match the completed artifact/i);
  });

  it('rejects stock JavaScript despite a handwritten private manifest and a text-file username marker', () => {
    const directory = artifactCopy();
    writeFileSync(join(directory, 'index.js'), "const route = 'wss://kws1.web.telegram.org/apiws';");
    writeFileSync(join(directory, 'notes.txt'), 'Sign in with your username');
    updateManifest(directory, {updateDigest: true});

    expect(() => verifyDeploymentArtifact({directory, expectedCommit, rootDirectory: repositoryRoot}))
    .toThrow(/official Telegram MTProto route/i);
  });

  it('requires the username marker in executable JavaScript', () => {
    const directory = artifactCopy();
    writeFileSync(join(directory, 'index.js'), [
      `const endpoint = ${JSON.stringify(target.endpoint)};`,
      `const fingerprint = ${JSON.stringify(target.fingerprint)};`
    ].join('\n'));
    writeFileSync(join(directory, 'notes.txt'), 'Sign in with your username');
    updateManifest(directory, {updateDigest: true});

    expect(() => verifyDeploymentArtifact({directory, expectedCommit, rootDirectory: repositoryRoot}))
    .toThrow(/username sign-in marker in executable JavaScript/i);
  });

  it('requires a matching source commit', () => {
    expect(() => verifyDeploymentArtifact({
      directory: validArtifact,
      expectedCommit: '1'.repeat(40),
      rootDirectory: repositoryRoot
    })).toThrow(/source commit does not match the expected repository commit/i);
  });

  it('verifies the artifact before copying it into the Node-free serving image', () => {
    const dockerfile = readFileSync(resolve('deploy/telegram-web/Dockerfile'), 'utf8');
    const verifyStep = dockerfile.indexOf('RUN node scripts/verify-deployment-artifact.mjs');
    const servingStage = dockerfile.indexOf('FROM nginx:');

    expect(verifyStep).toBeGreaterThanOrEqual(0);
    expect(servingStage).toBeGreaterThan(verifyStep);
    expect(dockerfile).toContain('COPY --from=artifact-verification /workspace/dist-private/ /usr/share/nginx/html/');
    expect(dockerfile).not.toContain('COPY public/');
    expect(readFileSync(resolve('.github/workflows/deployment-stack-checks.yml'), 'utf8'))
    .toContain('docker exec "$container_name" node --version');
  });
});
