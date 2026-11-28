import {createHash} from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const SOURCE_COMMIT_PATH = '.well-known/teagram-web/source-commit.txt';
export const MAX_PAGES_SITE_BYTES = 1_000_000_000;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const GENERATED_FILES = ['404.html', 'healthz', SOURCE_COMMIT_PATH];

function fail(message) {
  throw new Error(`[pages] ${message}`);
}

function comparePaths(left, right) {
  if(left < right) return -1;
  if(left > right) return 1;
  return 0;
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walkTree(directory, prefix = '') {
  const files = [];
  const entries = readdirSync(directory, {withFileTypes: true})
    .sort((left, right) => comparePaths(left.name, right.name));

  for(const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    const stat = lstatSync(absolutePath);

    if(stat.isSymbolicLink()) {
      fail(`the image tree contains a symlink: ${relativePath}`);
    }
    if(stat.isDirectory()) {
      files.push(...walkTree(absolutePath, relativePath));
      continue;
    }
    if(!stat.isFile()) {
      fail(`the image tree contains a non-regular file: ${relativePath}`);
    }

    files.push({
      path: relativePath.split(sep).join('/'),
      absolutePath,
      mode: stat.mode & 0o777,
      size: stat.size,
      sha256: fileSha256(absolutePath)
    });
  }

  return files;
}

function treeSha256(files) {
  const hash = createHash('sha256');
  for(const file of [...files].sort((left, right) => comparePaths(left.path, right.path))) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function assertNoConflict(filesByPath, path, expectedContents) {
  const existing = filesByPath.get(path);
  if(existing && !readFileSync(existing.absolutePath).equals(expectedContents)) {
    fail(`the image already contains a different ${path}`);
  }
}

function copyTree(sourceDirectory, outputDirectory) {
  mkdirSync(outputDirectory, {recursive: true});
  for(const entry of readdirSync(sourceDirectory, {withFileTypes: true})) {
    const sourcePath = join(sourceDirectory, entry.name);
    const outputPath = join(outputDirectory, entry.name);

    if(entry.isDirectory()) {
      copyTree(sourcePath, outputPath);
    } else {
      copyFileSync(sourcePath, outputPath);
      chmodSync(outputPath, lstatSync(sourcePath).mode & 0o777);
    }
  }
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch(error) {
    if(error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function preparePagesSite({sourceDirectory, outputDirectory, sourceCommit} = {}) {
  if(typeof sourceCommit !== 'string' || !COMMIT_PATTERN.test(sourceCommit)) {
    fail('source commit must be a full 40-character SHA');
  }
  if(typeof sourceDirectory !== 'string' || !sourceDirectory) {
    fail('source directory is missing');
  }
  if(typeof outputDirectory !== 'string' || !outputDirectory) {
    fail('output directory is missing');
  }

  const source = resolve(sourceDirectory);
  const output = resolve(outputDirectory);
  const sourceStat = lstatSync(source);
  if(!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    fail('image root must be a real directory');
  }
  if(source === output || output.startsWith(`${source}${sep}`)) {
    fail('Pages output must be outside the image root');
  }
  if(pathExists(output)) {
    fail('Pages output directory already exists');
  }

  const imageFiles = walkTree(source);
  const imageFilesByPath = new Map(imageFiles.map((file) => [file.path, file]));
  const indexFile = imageFilesByPath.get('index.html');
  if(!indexFile) fail('image root has no regular index.html');

  if(!imageFiles.some((file) => file.path.startsWith('.well-known/'))) {
    fail('image root has no .well-known files to preserve');
  }

  for(const file of imageFiles) {
    if(file.path === 'teagram-web-image-pin.json' || file.path.startsWith('.github/')) {
      fail(`the image root contains a file that must not be published: ${file.path}`);
    }
  }

  const indexContents = readFileSync(indexFile.absolutePath);
  const healthContents = Buffer.from('ok');
  const commitContents = Buffer.from(`${sourceCommit}\n`);
  assertNoConflict(imageFilesByPath, '404.html', indexContents);
  assertNoConflict(imageFilesByPath, 'healthz', healthContents);
  assertNoConflict(imageFilesByPath, SOURCE_COMMIT_PATH, commitContents);

  for(const file of imageFiles) {
    console.log(`pages_image_file=${JSON.stringify(file.path)} sha256=${file.sha256}`);
  }
  const imageTreeSha256 = treeSha256(imageFiles);
  console.log(`pages_image_tree_sha256=${imageTreeSha256}`);

  copyTree(source, output);
  const generatedContents = new Map([
    ['404.html', indexContents],
    ['healthz', healthContents],
    [SOURCE_COMMIT_PATH, commitContents]
  ]);
  for(const [path, contents] of generatedContents) {
    if(imageFilesByPath.has(path)) continue;
    const destination = join(output, path);
    mkdirSync(dirname(destination), {recursive: true});
    writeFileSync(destination, contents, {flag: 'wx', mode: 0o644});
  }

  const pagesFiles = walkTree(output);
  const pagesFilesByPath = new Map(pagesFiles.map((file) => [file.path, file]));
  for(const file of imageFiles) {
    const copiedFile = pagesFilesByPath.get(file.path);
    if(!copiedFile || copiedFile.sha256 !== file.sha256) {
      fail(`the Pages site does not match the image file: ${file.path}`);
    }
  }

  for(const [path, contents] of generatedContents) {
    const generatedFile = pagesFilesByPath.get(path);
    if(!generatedFile || !readFileSync(generatedFile.absolutePath).equals(contents)) {
      fail(`the Pages site has an invalid generated file: ${path}`);
    }
  }

  const expectedPaths = new Set(imageFiles.map((file) => file.path));
  for(const path of GENERATED_FILES) expectedPaths.add(path);
  if(pagesFiles.length !== expectedPaths.size || pagesFiles.some((file) => !expectedPaths.has(file.path))) {
    fail('the Pages site contains files outside the image tree and required routes');
  }

  const preservedImageFiles = pagesFiles.filter((file) => imageFilesByPath.has(file.path));
  const preservedTreeSha256 = treeSha256(preservedImageFiles);
  if(preservedTreeSha256 !== imageTreeSha256) {
    fail('the copied Pages files do not match the audited image tree');
  }

  const bytes = pagesFiles.reduce((total, file) => total + file.size, 0);
  if(bytes > MAX_PAGES_SITE_BYTES) {
    fail(`site size ${bytes} bytes exceeds the 1 GB limit`);
  }

  const pagesTreeSha256 = treeSha256(pagesFiles);
  console.log(`pages_image_tree_matches=true sha256=${preservedTreeSha256}`);
  console.log(`pages_well_known_files=${preservedImageFiles.filter((file) => file.path.startsWith('.well-known/')).length}`);
  console.log(`pages_site_files=${pagesFiles.length}`);
  console.log(`pages_site_size_bytes=${bytes}`);
  console.log(`pages_site_tree_sha256=${pagesTreeSha256}`);

  return {
    imageFiles: imageFiles.map((file) => file.path),
    pagesFiles: pagesFiles.map((file) => file.path),
    imageTreeSha256,
    preservedTreeSha256,
    pagesTreeSha256,
    bytes
  };
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
  if(args[0] !== 'prepare') fail('usage: prepare-pages-site.mjs prepare --source <dir> --output <dir> --commit <sha>');

  preparePagesSite({
    sourceDirectory: option(args, '--source'),
    outputDirectory: option(args, '--output'),
    sourceCommit: option(args, '--commit')
  });
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
