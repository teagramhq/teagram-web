import {execFileSync, spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadReviewedPrivateTarget} from './private-artifact-release.mjs';
import {verifyDeploymentArtifact} from './verify-deployment-artifact.mjs';

const ROOT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIRECTORY = resolve(ROOT_DIRECTORY, 'dist-private');

export function assertCleanSourceTree(rootDirectory = ROOT_DIRECTORY) {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: rootDirectory,
    encoding: 'utf8'
  });
  if(status.trim()) {
    throw new Error('[MT] deployment artifact build requires a clean source tree');
  }
}

function builderEnvironment(reviewed, keyPath) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('MTPROTO_') && !name.startsWith('VITE_') && name !== 'NODE_OPTIONS' &&
    !/(?:TOKEN|PASSWORD|SECRET|CREDENTIAL)/i.test(name)
  ));
  return {
    ...inherited,
    MTPROTO_TARGET_MODE: reviewed.MTPROTO_TARGET_MODE,
    MTPROTO_PRIVATE_ENDPOINT: reviewed.MTPROTO_PRIVATE_ENDPOINT,
    MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: keyPath
  };
}

function main() {
  assertCleanSourceTree(ROOT_DIRECTORY);
  const {reviewed, keyPath} = loadReviewedPrivateTarget({rootDirectory: ROOT_DIRECTORY});
  const viteCli = resolve(ROOT_DIRECTORY, 'node_modules/vite/bin/vite.js');
  const result = spawnSync(process.execPath, [viteCli, 'build', '--outDir', 'dist-private'], {
    cwd: ROOT_DIRECTORY,
    encoding: 'utf8',
    env: builderEnvironment(reviewed, keyPath),
    stdio: 'inherit'
  });
  if(result.error || result.status !== 0) {
    throw new Error('[MT] deployment artifact private build failed', {cause: result.error});
  }

  const audit = spawnSync(process.execPath, [
    resolve(ROOT_DIRECTORY, 'scripts/check-bundle-mangling.mjs'),
    OUTPUT_DIRECTORY
  ], {
    cwd: ROOT_DIRECTORY,
    encoding: 'utf8',
    env: builderEnvironment(reviewed, keyPath),
    stdio: 'inherit'
  });
  if(audit.error || audit.status !== 0) {
    throw new Error('[MT] deployment artifact bundle audit failed', {cause: audit.error});
  }

  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT_DIRECTORY,
    encoding: 'utf8'
  }).trim();
  const verified = verifyDeploymentArtifact({
    directory: OUTPUT_DIRECTORY,
    expectedCommit,
    rootDirectory: ROOT_DIRECTORY
  });
  console.log(`[private-artifact] deploymentArtifact=verified sourceCommit=${verified.manifest.sourceCommit}`);
  console.log(`[private-artifact] endpoint=${verified.target.endpoint} fingerprint=${verified.target.fingerprint}`);
  console.log(`[private-artifact] artifactDigest=${verified.manifest.artifactDigest}`);
}

const invokedScript = process.argv[1] && resolve(process.argv[1]);
if(invokedScript === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch(error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
