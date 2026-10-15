// Turns the Claude review log into a PR comment body and a verdict output.
//
// Usage: node scripts/claude-review-verdict.mjs <execution-file> <body-file>
//
// Writes verdict=blocking|clean|none to $GITHUB_OUTPUT and always exits 0:
// only an explicit BLOCKING verdict may fail the check, and a later step does
// that.
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const VERDICTS = new Map([
  ['CLAUDE_REVIEW: BLOCKING', 'blocking'],
  ['CLAUDE_REVIEW: CLEAN', 'clean']
]);

// Returns the review text of a successful run, or '' for anything else.
export function finalText(executionFile) {
  if(!executionFile) {
    return '';
  }
  let messages;
  try {
    messages = JSON.parse(readFileSync(executionFile, 'utf8'));
  } catch{
    return '';
  }
  if(!Array.isArray(messages)) {
    return '';
  }
  const result = messages.findLast((message) => message?.type === 'result');
  if(!result || result.subtype !== 'success' || result.is_error) {
    return '';
  }
  return typeof result.result === 'string' ? result.result : '';
}

export function verdictOf(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if(!lines.length) {
    return 'none';
  }
  const last = lines[lines.length - 1].replace(/^[`*_ ]+|[`*_ ]+$/g, '');
  return VERDICTS.get(last) ?? 'none';
}

export function main(argv, env = process.env) {
  if(argv.length !== 2) {
    console.error('Usage: claude-review-verdict.mjs <execution-file> <body-file>');
    return 2;
  }
  const [executionFile, bodyFile] = argv;
  const text = finalText(executionFile);
  const verdict = verdictOf(text);
  if(verdict === 'none') {
    console.log('::warning::Claude review gave no verdict (timeout, auth or quota error, or a malformed reply); not blocking.');
    if(text) {
      console.log(text);
    }
  } else {
    const head = (env.HEAD_SHA ?? '').slice(0, 12);
    const title = head ? `**Claude review** of \`${head}\`` : '**Claude review**';
    writeFileSync(bodyFile, `${title}\n\n${text.trim()}\n`);
  }
  if(env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `verdict=${verdict}\n`);
  } else {
    console.log(`verdict=${verdict}`);
  }
  return 0;
}

if(import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
