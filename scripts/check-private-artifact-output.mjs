#!/usr/bin/env node

// Run with `pnpm run check:private-artifact-output`. This invokes Vite directly
// instead of the composite `pnpm build`, which also runs the full local suite.

import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {verifyPrivateArtifactCsp, verifyPrivateArtifactManifest} from './private-artifact.mjs';
import {resolveMtprotoTarget} from './mtproto-target.mjs';

const ROOT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_ENDPOINT = 'wss://telegramd.test/apiws';
const PUBLIC_KEY_FILE = resolve(ROOT_DIRECTORY, 'scripts/fixtures/private-mtproto-public.pem');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'teagram-private-artifact-output-'));
const outputDirectory = join(temporaryRoot, 'dist-private');
const targetEnvironment = {
  MTPROTO_TARGET_MODE: 'private',
  MTPROTO_PRIVATE_ENDPOINT: PRIVATE_ENDPOINT,
  MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: PUBLIC_KEY_FILE
};

function builderEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !name.startsWith('MTPROTO_') && !name.startsWith('VITE_') && name !== 'NODE_OPTIONS' &&
      !/(?:TOKEN|PASSWORD|SECRET|CREDENTIAL)/i.test(name)
    )),
    ...targetEnvironment
  };
}

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIRECTORY,
    encoding: 'utf8',
    env: environment
  });
  if(result.error || result.status !== 0) {
    const details = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`private artifact output check command failed${details ? `\n${details}` : ''}`);
  }
  return result.stdout;
}

try {
  const target = resolveMtprotoTarget(targetEnvironment);
  const viteCli = resolve(ROOT_DIRECTORY, 'node_modules/vite/bin/vite.js');
  const buildCommand = [process.execPath, viteCli, 'build', '--outDir', outputDirectory];
  run(buildCommand[0], buildCommand.slice(1), builderEnvironment());
  const auditOutput = run(process.execPath, [
    resolve(ROOT_DIRECTORY, 'scripts/check-bundle-mangling.mjs'),
    outputDirectory
  ], builderEnvironment());
  const manifest = verifyPrivateArtifactManifest(outputDirectory, target);
  verifyPrivateArtifactCsp(outputDirectory, target.endpoint);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT_DIRECTORY,
    encoding: 'utf8'
  }).trim();
  if(manifest.sourceCommit !== head) {
    throw new Error('[MT] private artifact output check source commit does not match HEAD');
  }

  process.stdout.write([
    '[private-artifact] output=verified',
    `[private-artifact] buildCommand=${buildCommand.join(' ')}`,
    `[private-artifact] endpoint=${manifest.endpoint}`,
    `[private-artifact] fingerprint=${manifest.fingerprint}`,
    `[private-artifact] sourceCommit=${manifest.sourceCommit}`,
    `[private-artifact] artifactDigest=${manifest.artifactDigest}`,
    '[private-artifact] audit=source maps and directives, alternate WSS and cleartext WS, official MTProto routes and IPv4/IPv6 DC addresses, official RSA fingerprints and moduli, private-key blocks',
    auditOutput.trimEnd()
  ].join('\n') + '\n');
} catch(error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, {recursive: true, force: true});
}
