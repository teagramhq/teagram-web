import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {main} from './claude-review-verdict.mjs';

const WORKFLOW = resolve('.github/workflows/claude-review.yml');
const SAME_REPO = 'github.event.pull_request.head.repo.full_name == github.repository';
const ENABLED = 'vars.CLAUDE_REVIEW_ENABLED == \'true\'';
const ACTION_PIN = /^\s*(?:-\s+)?uses:\s*anthropics\/claude-code-action@[0-9a-f]{40}(\s|$)/;

const indentOf = (line) => line.length - line.trimStart().length;

// Returns the lines nested under the first `key:` line.
function block(lines, key) {
  const index = lines.findIndex((line) => line.trim() === `${key}:` || line.trim().startsWith(`${key}: `));
  if(index === -1) {
    return [];
  }
  const nested = [];
  for(const child of lines.slice(index + 1)) {
    if(child.trim() && indentOf(child) <= indentOf(lines[index])) {
      break;
    }
    nested.push(child);
  }
  return nested;
}

function contractErrors(text) {
  const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  const errors = [];
  if(text.includes('pull_request_target')) {
    errors.push('must not use pull_request_target');
  }
  const trigger = block(block(lines, 'on'), 'pull_request');
  if(!trigger.length) {
    errors.push('must trigger on pull_request');
  }
  if(!block(trigger, 'paths').some((line) => line.trim().startsWith('- '))) {
    errors.push('pull_request trigger must keep a paths filter');
  }
  const conditions = lines.filter((line) => line.trim().startsWith('if:'));
  if(!conditions.some((line) => line.includes(SAME_REPO) && line.includes('!github.event.pull_request.draft'))) {
    errors.push('job must skip fork and draft pull requests');
  }
  if(!conditions.some((line) => line.trim().startsWith(`if: ${ENABLED} && `))) {
    errors.push('job must be gated on vars.CLAUDE_REVIEW_ENABLED');
  }
  const uses = lines.filter((line) => line.includes('anthropics/claude-code-action@'));
  if(!uses.length || !uses.every((line) => ACTION_PIN.test(line))) {
    errors.push('claude-code-action must be pinned by full commit SHA');
  }
  lines.forEach((line, index) => {
    if(!line.trim().startsWith('permissions:')) {
      return;
    }
    const inline = line.split(':').slice(1).join(':').trim();
    const entries = inline ? [inline] : block(lines.slice(index), 'permissions').map((child) => child.trim());
    for(const entry of entries) {
      if(entry.includes('write') && entry.replaceAll(' ', '') !== 'pull-requests:write') {
        errors.push(`write permission beyond pull-requests: ${entry}`);
      }
    }
  });
  return errors;
}

describe('Claude review workflow contract', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const expectBroken = (mutated) => {
    expect(mutated).not.toBe(text);
    expect(contractErrors(mutated)).not.toEqual([]);
  };

  it('meets the contract', () => {
    expect(contractErrors(text)).toEqual([]);
  });

  it('rejects pull_request_target', () => {
    expectBroken(text.replace('  pull_request:\n', '  pull_request_target:\n'));
  });

  it('rejects a missing same-repository condition', () => {
    expectBroken(text.replace(`${SAME_REPO} && `, ''));
  });

  it('rejects a missing enabled switch', () => {
    expectBroken(text.replace(`${ENABLED} && `, ''));
    expectBroken(text.replace(ENABLED, ENABLED.replace('==', '!=').replace('true', 'false')));
  });

  it('rejects a missing path filter', () => {
    expectBroken(text.replace(/ {4}paths:\n( {6}- .*\n)+/, ''));
  });

  it('rejects an unpinned action', () => {
    expectBroken(text.replace(/claude-code-action@[0-9a-f]{40}/, 'claude-code-action@v1'));
  });

  it('rejects write permissions beyond pull-requests', () => {
    expectBroken(text.replace('  contents: read\n', '  contents: write\n'));
    expectBroken(text.replace('  pull-requests: write\n', '  pull-requests: write\n  id-token: write\n'));
    expectBroken(text.replace('    runs-on:', '    permissions: write-all\n    runs-on:'));
  });
});

describe('Claude review verdict', () => {
  let dir;

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, {recursive: true, force: true});
  });

  const resultLog = (result, subtype = 'success') => [
    {type: 'system', subtype: 'init'},
    {type: 'result', subtype, is_error: subtype !== 'success', result}
  ];

  function runVerdict(log) {
    dir = mkdtempSync(join(tmpdir(), 'claude-review-'));
    const execution = join(dir, 'execution.json');
    if(log !== undefined) {
      writeFileSync(execution, JSON.stringify(log));
    }
    const body = join(dir, 'body.md');
    const output = join(dir, 'output');
    const logged = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));
    const code = main([log === undefined ? '' : execution, body], {GITHUB_OUTPUT: output, HEAD_SHA: '0123456789abcdef'});
    expect(code).toBe(0);
    return {
      verdict: readFileSync(output, 'utf8').trim().replace('verdict=', ''),
      body: existsSync(body) ? readFileSync(body, 'utf8') : '',
      stdout: logged.join('\n')
    };
  }

  it('reports a blocking verdict with its findings', () => {
    const {verdict, body} = runVerdict(resultLog('`a.ts:3` drops the key.\n\nCLAUDE_REVIEW: BLOCKING\n'));
    expect(verdict).toBe('blocking');
    expect(body).toContain('`a.ts:3` drops the key.');
    expect(body).toContain('`0123456789ab`');
  });

  it('reports a clean verdict', () => {
    const {verdict, body} = runVerdict(resultLog('Looks right.\n**CLAUDE_REVIEW: CLEAN**'));
    expect(verdict).toBe('clean');
    expect(body).toContain('Looks right.');
  });

  it('needs the verdict on the last line', () => {
    const {verdict, body, stdout} = runVerdict(resultLog('CLAUDE_REVIEW: BLOCKING\nMore text.'));
    expect(verdict).toBe('none');
    expect(body).toBe('');
    expect(stdout).toContain('::warning::');
  });

  it.each([
    ['a missing log', undefined],
    ['a non-list log', 'not a list'],
    ['an empty log', []],
    ['a failed run', resultLog('CLAUDE_REVIEW: BLOCKING', 'error_max_turns')]
  ])('stays neutral for %s', (_, log) => {
    const {verdict, body, stdout} = runVerdict(log);
    expect(verdict).toBe('none');
    expect(body).toBe('');
    expect(stdout).toContain('::warning::');
  });
});
