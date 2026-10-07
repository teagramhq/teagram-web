import fs from 'node:fs';
import path from 'node:path';

const forbiddenMarkers = [
  'TWEB_QR_FIXTURE_DEV_ONLY_SENTINEL_6D9B42E1',
  'src/qrFixtureApp.tsx',
  'src/qrFixtureEntry.ts',
  'window.qrFixture'
];

function listFiles(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

export function assertNoQrFixtureArtifactContent(directory) {
  const leaks = [];
  for(const file of listFiles(directory)) {
    const contents = fs.readFileSync(file);
    for(const marker of forbiddenMarkers) {
      if(contents.includes(Buffer.from(marker))) {
        leaks.push(`${path.relative(directory, file)} (${marker})`);
      }
    }
  }

  if(leaks.length) {
    throw new Error(`QR fixture content detected in artifact: ${leaks.join(', ')}`);
  }
}
