const fs = require('fs');
const path = require('path');
const {unzipSync} = require('fflate');

// fflate hands back plain files, so an entry cannot be a symlink, and one whose name leads
// out of the output folder is refused
const unzip = (zipPath, outputDir) => {
  const outputRoot = path.resolve(outputDir);
  const entries = unzipSync(fs.readFileSync(zipPath));
  for(const name in entries) {
    if(name.endsWith('/')) {
      continue;
    }

    const dest = path.resolve(outputRoot, name);
    const relativePath = path.relative(outputRoot, dest);
    if(!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`Refusing to unzip ${name} outside of ${outputRoot}`);
    }

    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.writeFileSync(dest, entries[name]);
  }
};

module.exports = unzip;
