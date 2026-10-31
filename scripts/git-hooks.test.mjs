import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, describe, expect, it} from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories = [];

function git(directory, ...args) {
  return execFileSync('git', args, {cwd: directory, encoding: 'utf8'}).trim();
}

function installHooks(directory) {
  mkdirSync(join(directory, '.githooks'));
  for(const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
    const hookPath = join(directory, '.githooks', hook);
    copyFileSync(join(repositoryRoot, '.githooks', hook), hookPath);
    chmodSync(hookPath, 0o755);
  }
  git(directory, 'config', 'core.hooksPath', '.githooks');
}

function createDivergedRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'teagram-git-hooks-'));
  temporaryDirectories.push(directory);

  git(directory, 'init', '--quiet', '--initial-branch=main');
  git(directory, 'config', 'user.name', 'Git Hook Test');
  git(directory, 'config', 'user.email', 'git-hook-test@example.invalid');
  git(directory, 'config', 'commit.gpgsign', 'false');

  writeFileSync(join(directory, 'base.txt'), 'base\n');
  git(directory, 'add', 'base.txt');
  git(directory, 'commit', '--quiet', '-m', 'chore: create base');
  const baseCommit = git(directory, 'rev-parse', 'HEAD');

  git(directory, 'checkout', '--quiet', '-b', 'feature');
  writeFileSync(join(directory, 'feature.txt'), 'feature\n');
  git(directory, 'add', 'feature.txt');
  git(directory, 'commit', '--quiet', '-m', 'feat: add feature change');

  git(directory, 'checkout', '--quiet', 'main');
  writeFileSync(join(directory, 'main.txt'), 'main\n');
  git(directory, 'add', 'main.txt');
  git(directory, 'commit', '--quiet', '-m', 'feat: add main change');
  git(directory, 'checkout', '--quiet', 'feature');

  installHooks(directory);

  expect(git(directory, 'merge-base', 'main', 'feature')).toBe(baseCommit);
  return directory;
}

function createPushRepository() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'teagram-git-hooks-push-'));
  temporaryDirectories.push(temporaryDirectory);
  const directory = join(temporaryDirectory, 'work');
  const remoteDirectory = join(temporaryDirectory, 'remote.git');
  mkdirSync(directory);

  git(directory, 'init', '--quiet', '--initial-branch=main');
  git(directory, 'config', 'user.name', 'Git Hook Test');
  git(directory, 'config', 'user.email', 'git-hook-test@example.invalid');
  git(directory, 'config', 'commit.gpgsign', 'false');

  writeFileSync(join(directory, 'base.txt'), 'base\n');
  git(directory, 'add', 'base.txt');
  git(directory, 'commit', '--quiet', '-m', 'chore: create base');
  git(temporaryDirectory, 'init', '--quiet', '--bare', '--initial-branch=main', remoteDirectory);
  git(directory, 'remote', 'add', 'origin', remoteDirectory);
  git(directory, 'push', '--quiet', 'origin', 'main');
  git(directory, 'fetch', '--quiet', 'origin');
  git(directory, 'checkout', '--quiet', '-b', 'feature');
  installHooks(directory);

  mkdirSync(join(directory, 'src'));
  return {directory, remoteDirectory};
}

afterAll(() => {
  for(const directory of temporaryDirectories) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe('commit message hook', () => {
  it('allows git merge to merge diverged main into feature with hooks active', () => {
    const directory = createDivergedRepository();

    git(directory, 'merge', '--no-edit', 'main');

    expect(git(directory, 'log', '-1', '--format=%s')).toMatch(/^Merge /);
    expect(git(directory, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' '))
    .toHaveLength(3);
  });

  it('allows a non-merge-prefixed subject while Git is writing a merge commit', () => {
    const directory = createDivergedRepository();

    git(directory, 'merge', '--no-edit', '--message', 'synchronize upstream', 'main');

    expect(git(directory, 'log', '-1', '--format=%s')).toBe('synchronize upstream');
    expect(git(directory, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' '))
    .toHaveLength(3);
  });

  it('continues rejecting ordinary subjects that violate the message rules', () => {
    const directory = createDivergedRepository();
    const messagePath = join(directory, 'COMMIT_EDITMSG');
    writeFileSync(messagePath, 'MAIN-3031 missing a conventional type\n');

    const result = spawnSync(join(directory, '.githooks', 'commit-msg'), [messagePath], {
      cwd: directory,
      encoding: 'utf8'
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Conventional Commits');
    expect(result.stderr).toContain('issue key');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('skips validation for rewrite and revert subjects generated by Git tooling', () => {
    const directory = createDivergedRepository();
    const hookPath = join(directory, '.githooks', 'commit-msg');
    const messagePath = join(directory, 'COMMIT_EDITMSG');
    const subjects = [
      "Merge remote-tracking branch 'origin/main' into fix/MAIN-3031",
      'Revert "feat: MAIN-3031 change"',
      'fixup! feat: MAIN-3031 change',
      'squash! feat: MAIN-3031 change',
      'amend! feat: MAIN-3031 change'
    ];

    for(const subject of subjects) {
      writeFileSync(messagePath, `${subject}\n\nCo-Authored-By: Test Author <test@example.invalid>\nGenerated with test tooling\n`);
      expect(() => execFileSync(hookPath, [messagePath], {cwd: directory})).not.toThrow();
    }
  });
});

describe('pre-commit hook', () => {
  it('fixes staged source and preserves unstaged edits', () => {
    const directory = createDivergedRepository();
    const sourceDirectory = join(directory, 'src');
    mkdirSync(sourceDirectory);
    const fixablePath = join(sourceDirectory, 'fixable.ts');
    const unstagedPath = join(sourceDirectory, 'unstaged.ts');
    const originalUnstaged = 'const untouched = 1;\n';
    const changedUnstaged = 'const untouched = 2;\n';
    writeFileSync(unstagedPath, originalUnstaged);
    git(directory, 'add', 'src/unstaged.ts');
    git(directory, 'commit', '--quiet', '-m', 'chore: add source baseline');

    const oxlintPath = join(directory, 'node_modules', '.bin', 'oxlint');
    mkdirSync(dirname(oxlintPath), {recursive: true});
    writeFileSync(oxlintPath, `#!/usr/bin/env node
const {readFileSync, writeFileSync} = require('node:fs');
const paths = process.argv.slice(3);
if(process.argv[2] !== '--fix' || paths.length !== 1 || paths[0] !== 'src/fixable.ts') {
  console.error('oxlint did not receive only the staged source file');
  process.exit(1);
}
const source = readFileSync(paths[0], 'utf8');
writeFileSync(paths[0], source.replace('const answer = 42;', 'const answer: number = 42;'));
`);
    chmodSync(oxlintPath, 0o755);

    writeFileSync(fixablePath, 'const answer = 42;\n');
    git(directory, 'add', 'src/fixable.ts');
    writeFileSync(unstagedPath, changedUnstaged);
    git(directory, 'commit', '--quiet', '-m', 'fix: autofix staged source');

    expect(git(directory, 'show', 'HEAD:src/fixable.ts')).toBe('const answer: number = 42;');
    expect(git(directory, 'show', 'HEAD:src/unstaged.ts')).toBe(originalUnstaged.trim());
    expect(readFileSync(unstagedPath, 'utf8')).toBe(changedUnstaged);
  });
});

describe('pre-push hook', () => {
  it('rejects a push when typecheck reports a TypeScript error', () => {
    const {directory, remoteDirectory} = createPushRepository();
    const typeError = "src/type-error.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.";
    const sourcePath = join(directory, 'src', 'type-error.ts');
    const tscPath = join(directory, 'node_modules', '.bin', 'tsc');
    const fakeBin = join(directory, 'fake-bin');
    const pnpmPath = join(fakeBin, 'pnpm');
    mkdirSync(join(directory, 'node_modules', '.bin'), {recursive: true});
    mkdirSync(fakeBin);
    writeFileSync(tscPath, '#!/bin/sh\nexit 0\n');
    chmodSync(tscPath, 0o755);
    writeFileSync(pnpmPath, `#!/usr/bin/env node
if(process.argv.slice(2).join(' ') !== 'run typecheck') {
  console.error('unexpected pnpm invocation');
  process.exit(2);
}
console.error(${JSON.stringify(typeError)});
process.exit(2);
`);
    chmodSync(pnpmPath, 0o755);

    writeFileSync(sourcePath, 'const answer: number = "not a number";\n');
    git(directory, 'add', 'src/type-error.ts');
    git(directory, 'commit', '--quiet', '-m', 'test: add type error');

    const push = spawnSync('git', ['push', 'origin', 'feature'], {
      cwd: directory,
      encoding: 'utf8',
      env: {...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`}
    });
    const remoteFeature = spawnSync('git', ['--git-dir', remoteDirectory, 'show-ref', '--verify', 'refs/heads/feature'], {
      encoding: 'utf8'
    });

    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain(typeError);
    expect(remoteFeature.status).not.toBe(0);
  });
});
