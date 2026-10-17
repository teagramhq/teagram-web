#!/usr/bin/env node

import {resolve} from 'node:path';
import {auditPrivateArtifactRuntimeAssets} from './private-artifact.mjs';

const directory = resolve(process.argv[2] === '--' ? (process.argv[3] || 'dist-private') : (process.argv[2] || 'dist-private'));

try {
  const {assetCount, referenceCount} = auditPrivateArtifactRuntimeAssets(directory);
  process.stdout.write(`[private-artifact] runtimeAssets=verified files=${assetCount} references=${referenceCount}\n`);
} catch(error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
