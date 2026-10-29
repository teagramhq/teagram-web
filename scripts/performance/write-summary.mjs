import {mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {evaluatePerformance, formatPerformanceTable} from './policy.mjs';

const reportPath = resolve(process.env.PERF_REPORT_PATH || '.performance-report.json');
const historyDirectory = resolve(process.env.PERF_HISTORY_DIRECTORY || '.performance-history');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
let report = {variants: {}};
const failures = [];

try {
  report = readJson(reportPath);
} catch(error) {
  failures.push(`browser report could not be read: ${error.message}`);
}

const history = [];
try {
  for(const filename of readdirSync(historyDirectory).filter((name) => name.endsWith('.json')).sort()) {
    try {
      history.push(readJson(join(historyDirectory, filename)));
    } catch(error) {
      failures.push(`history file ${filename} is invalid: ${error.message}`);
    }
  }
} catch(error) {
  if(error.code !== 'ENOENT') failures.push(`history could not be read: ${error.message}`);
}

const evaluation = evaluatePerformance(report, history);
failures.push(...evaluation.blockingFailures);
if(process.env.PERF_BROWSER_OUTCOME !== 'success') {
  failures.push(`browser performance run did not succeed (${process.env.PERF_BROWSER_OUTCOME || 'not run'})`);
}

const table = formatPerformanceTable(evaluation);
const summary = [
  '## Web performance at scale',
  '',
  `Fixture: \`${report.fixtureVersion || 'not recorded'}\`; server runtime commit: \`${report.serverCommit || 'not recorded'}\`; fixture seed commit: \`${report.fixtureServerCommit || 'not recorded'}\`.`,
  '',
  table,
  '',
  evaluation.calibratedScenarios === 0 ? 'Fixed 100x timing budgets and scroll quality gates block immediately. Relative timing noise bands and the 100x/1x slowdown ceiling are report-only until each scale and scenario has 20 compatible successful main runs. Pull requests require complete base bundle measurements; bundle growth also blocks immediately.' : `Timing calibration is active for ${evaluation.calibratedScenarios} scale/scenario row(s); fixed 100x timing budgets and scroll quality gates block immediately. Relative timing noise bands and scale comparisons remain report-only for uncalibrated rows until each reaches 20 compatible successful main runs. Pull requests require complete base bundle measurements; bundle growth also blocks immediately.`,
  failures.length ? `\nBlocking findings:\n${failures.map((failure) => `- ${failure}`).join('\n')}` : '\nNo blocking performance findings.'
].join('\n');

if(process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, {flag: 'a'});
else process.stdout.write(`${summary}\n`);

if(
  process.env.GITHUB_EVENT_NAME === 'push' &&
  process.env.GITHUB_REF === 'refs/heads/master' &&
  failures.length === 0
) {
  mkdirSync(historyDirectory, {recursive: true});
  const historyPath = join(historyDirectory, `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.json`);
  writeFileSync(historyPath, `${JSON.stringify({...report, recordedAt: new Date().toISOString()}, null, 2)}\n`);
  const files = readdirSync(historyDirectory).filter((name) => name.endsWith('.json')).sort();
  for(const oldFile of files.slice(0, Math.max(0, files.length - 20))) {
    unlinkSync(join(historyDirectory, oldFile));
  }
}

if(failures.length) {
  process.stderr.write(`${failures.map((failure) => `::error::${failure}`).join('\n')}\n`);
  process.exitCode = 1;
}
