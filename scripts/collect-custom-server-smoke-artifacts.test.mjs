import {execFileSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {afterEach, describe, expect, it} from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const collectorPath = join(repositoryRoot, '.github/scripts/collect-custom-server-smoke-artifacts.mjs');
const secret = 'CUSTOM_SERVER_SECRET_SENTINEL_79a40b1e';
const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, {recursive: true, force: true}));
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'teagram-custom-server-artifact-test-'));
  temporaryDirectories.push(root);
  const runnerTemp = join(root, 'runner-temp');
  const outputDirectory = join(runnerTemp, 'custom-server-playwright-results');
  const testDirectory = join(outputDirectory, 'customServerLocalSignIn.spec.ts-smoke');
  mkdirSync(testDirectory, {recursive: true});
  const startupLogPath = join(runnerTemp, 'teagramd-startup.log');
  const serverLogPath = join(runnerTemp, 'teagramd.log');
  const outputPath = join(runnerTemp, 'github-output');
  mkdirSync(runnerTemp, {recursive: true});

  return {root, runnerTemp, outputDirectory, testDirectory, startupLogPath, serverLogPath, outputPath};
}

function runCollector(fixture, extraEnvironment = {}) {
  const reportPath = join(fixture.runnerTemp, 'playwright-report.json');
  const environment = {
    ...process.env,
    RUNNER_TEMP: fixture.runnerTemp,
    TWEB_PRIVATE_AUTH_OUTPUT_DIR: fixture.outputDirectory,
    TWEB_PRIVATE_AUTH_JSON_REPORT: reportPath,
    GITHUB_OUTPUT: fixture.outputPath,
    GITHUB_WORKSPACE: repositoryRoot,
    TEAGRAMD_STARTUP_LOG_FILE: fixture.startupLogPath,
    TEAGRAMD_LOG_FILE: fixture.serverLogPath,
    GITHUB_RUN_ID: '39471584534',
    GITHUB_RUN_ATTEMPT: '2',
    ...extraEnvironment
  };

  const stdout = execFileSync(process.execPath, [collectorPath], {encoding: 'utf8', env: environment});
  const output = readFileSync(fixture.outputPath, 'utf8');
  const artifactDirectory = output.match(/^artifact_path=(.+)$/m)?.[1];
  return {artifactDirectory, stdout, output, reportPath};
}

function gitRevision(directory) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch{
    return null;
  }
}

function traceArchive() {
  const events = [
    {type: 'context-options', version: 8, browserName: 'chromium', options: {storageState: secret}},
    {
      type: 'before',
      callId: 'click1',
      class: 'Page',
      method: 'click',
      startTime: 1,
      title: secret,
      params: {password: secret, text: 'Sign in'}
    },
    {
      type: 'before',
      callId: 'group1',
      class: 'Tracing',
      method: 'group',
      startTime: 2,
      title: 'Sign in scenario',
      params: {token: secret}
    },
    {type: 'after', callId: 'click1', endTime: 3, error: {message: secret}},
    {type: 'input', callId: 'input1', point: {x: 12, y: 34}},
    {type: 'console', message: secret}
  ];

  return zipSync({
    'trace.trace': strToU8(events.map((event) => JSON.stringify(event)).join('\n') + '\n'),
    'trace.network': strToU8(`Authorization: Bearer ${secret}`),
    'resources/page.json': strToU8(JSON.stringify({cookie: secret}))
  });
}

describe('custom-server smoke artifact collector', () => {
  it('redacts logs and trace data, retains safe actions, and reports report-derived context and revisions', () => {
    const fixture = createFixture();
    writeFileSync(fixture.startupLogPath, 'stage=start_server result=started\n');
    writeFileSync(fixture.serverLogPath, JSON.stringify({
      level: 'ERROR',
      rpc_method: 'signIn',
      status: 401,
      error: 'unauthorized',
      password: secret,
      authorization: `Bearer ${secret}`
    }) + '\n');
    writeFileSync(join(fixture.testDirectory, 'trace.zip'), traceArchive());
    const reportPath = join(fixture.runnerTemp, 'playwright-report.json');
    writeFileSync(reportPath, JSON.stringify({
      suites: [{
        specs: [{
          title: 'isolates two server tabs when a custom server worker takes control',
          file: 'e2e/customServerLocalSignIn.spec.ts',
          tests: [{results: [{
            status: 'failed',
            errors: [{
              message: `# Error details\n\`\`\`text\nError: ${secret}\n\`\`\``,
              location: {line: 42, column: 8}
            }]
          }]}]
        }]
      }]
    }));

    const {artifactDirectory, output, reportPath: removedReportPath} = runCollector(fixture, {
      TWEB_MIGRATION_OUTCOME: 'success',
      TWEB_STARTUP_OUTCOME: 'success',
      TWEB_CUSTOM_SERVER_SMOKE_OUTCOME: 'failure'
    });

    expect(output).toContain('artifact_ready=true');
    expect(readdirSync(artifactDirectory).sort()).toEqual([
      'error-context.md', 'fixture.log', 'run-metadata.json', 'trace.zip'
    ]);
    expect(existsSync(removedReportPath)).toBe(false);

    const context = readFileSync(join(artifactDirectory, 'error-context.md'), 'utf8');
    const fixtureLog = readFileSync(join(artifactDirectory, 'fixture.log'), 'utf8');
    const metadata = JSON.parse(readFileSync(join(artifactDirectory, 'run-metadata.json'), 'utf8'));
    const safeTrace = unzipSync(readFileSync(join(artifactDirectory, 'trace.zip')));
    const traceText = strFromU8(safeTrace['trace.trace']);
    const traceEvents = traceText.trim().split('\n').map((event) => JSON.parse(event));

    expect(context).toContain('e2e/customServerLocalSignIn.spec.ts:42:8');
    expect(context).not.toContain(secret);
    expect(fixtureLog).toContain('rpc_method=signIn');
    expect(fixtureLog).toContain('status=401');
    expect(fixtureLog).not.toContain(secret);
    expect(Object.keys(safeTrace).sort()).toEqual(['trace.network', 'trace.trace']);
    expect(safeTrace['trace.network']).toHaveLength(0);
    expect(traceEvents.map((event) => event.type)).toEqual([
      'context-options', 'before', 'before', 'after', 'input'
    ]);
    expect(traceEvents[1]).toMatchObject({title: 'Page.click', params: {}});
    expect(traceEvents[2]).toMatchObject({title: 'Sign in scenario', params: {}});
    expect(traceEvents[3].error.message).toBe('Failure details are in the sanitized error-context.md.');
    expect(traceText).not.toContain(secret);

    expect(metadata).toMatchObject({
      web_sha: gitRevision(repositoryRoot),
      server_sha: gitRevision(join(repositoryRoot, 'teagram-server')),
      run_id: '39471584534',
      run_attempt: '2',
      fixture_migration_outcome: 'success',
      fixture_startup_outcome: 'success',
      browser_smoke_outcome: 'failure',
      browser_trace_available: true,
      browser_trace_files: ['trace.zip'],
      browser_trace_unavailable_reason: null,
      error_context_available: true,
      fixture_log_files_observed: ['startup', 'server'],
      trace_sanitization_failures: 0
    });
  });

  it('marks a generated fallback error context as available', () => {
    const fixture = createFixture();
    writeFileSync(fixture.startupLogPath, '');

    const {artifactDirectory} = runCollector(fixture, {TWEB_CUSTOM_SERVER_SMOKE_OUTCOME: 'failure'});
    const context = readFileSync(join(artifactDirectory, 'error-context.md'), 'utf8');
    const metadata = JSON.parse(readFileSync(join(artifactDirectory, 'run-metadata.json'), 'utf8'));

    expect(context).toContain('Playwright failed without retaining its error-context file.');
    expect(metadata.error_context_available).toBe(true);
  });
});
