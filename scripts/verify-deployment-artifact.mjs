import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPrivateArtifactCsp, verifyPrivateArtifactManifest, verifyPrivateUsernameSignIn} from './private-artifact.mjs';
import {loadReviewedPrivateTarget} from './private-artifact-release.mjs';

const ROOT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error('[MT] deployment artifact ' + message);
}

export function verifyDeploymentArtifact({directory, expectedCommit, rootDirectory = ROOT_DIRECTORY} = {}) {
  if(typeof directory !== 'string' || !directory) {
    fail('directory is missing');
  }
  if(typeof expectedCommit !== 'string' || !/^[0-9a-f]{40}$/.test(expectedCommit)) {
    fail('source commit is invalid');
  }

  const {target} = loadReviewedPrivateTarget({rootDirectory});
  const manifest = verifyPrivateArtifactManifest(directory, target);
  if(manifest.sourceCommit !== expectedCommit) {
    fail('source commit does not match the expected repository commit');
  }
  verifyPrivateArtifactCsp(directory, target.endpoint);
  verifyPrivateUsernameSignIn(directory);
  return {manifest, target};
}

function option(args, name) {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if(index === -1 || !value || value.startsWith('--')) {
    fail(`${name} requires a value`);
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const result = verifyDeploymentArtifact({
    directory: option(args, '--dist'),
    expectedCommit: option(args, '--commit')
  });
  console.log(`[private-artifact] deploymentArtifact=verified sourceCommit=${result.manifest.sourceCommit}`);
  console.log(`[private-artifact] endpoint=${result.target.endpoint} fingerprint=${result.target.fingerprint}`);
  console.log(`[private-artifact] artifactDigest=${result.manifest.artifactDigest}`);
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
