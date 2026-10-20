#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import {appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

const ROOT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_DIRECTORY_PATTERN = /customServerLocalSignIn/;
const TEST_NAME = 'isolates two server tabs when a custom server worker takes control';
const TRACE_ACTION_TYPES = new Set(['before', 'after', 'input']);
const SAFE_SERVER_ERROR_TYPES = new Set([
  'bad_request', 'conflict', 'forbidden', 'internal', 'invalid_argument', 'not_found', 'timeout', 'unauthorized'
]);

function regularFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isInside(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function readFileIfRegular(path) {
  if(!path || !regularFile(path)) return undefined;
  return readFileSync(path, 'utf8');
}

function findTestArtifacts(directory) {
  const files = [];
  if(!directory || !existsSync(directory)) return files;
  const rootStat = lstatSync(directory);
  if(!rootStat.isDirectory() || rootStat.isSymbolicLink()) return files;

  function visit(path, inTargetDirectory) {
    for(const entry of readdirSync(path, {withFileTypes: true})) {
      if(entry.isSymbolicLink()) continue;
      const entryPath = join(path, entry.name);
      if(entry.isDirectory()) {
        visit(entryPath, inTargetDirectory || TEST_DIRECTORY_PATTERN.test(entry.name));
      } else if(inTargetDirectory && (entry.name === 'error-context.md' || entry.name === 'trace.zip')) {
        files.push(entryPath);
      }
    }
  }

  visit(directory, false);
  return files.sort();
}

function safeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value);
}

function safeEventId(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_@.:-]{0,119}$/.test(value);
}

function safeGroupTitle(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 &&
    /^[A-Za-z0-9][A-Za-z0-9 _.:/-]*$/.test(value) &&
    !/(?:password|proof|auth.?key|cookie|session|token|bearer)/i.test(value);
}

function safeTraceEvent(event) {
  if(event.type === 'context-options') {
    return {
      type: 'context-options',
      version: Number.isSafeInteger(event.version) ? event.version : 8,
      origin: event.origin === 'testRunner' ? 'testRunner' : 'library',
      browserName: event.browserName === 'chromium' ? 'chromium' : 'browser',
      ...(typeof event.playwrightVersion === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(event.playwrightVersion) ?
        {playwrightVersion: event.playwrightVersion} : {}),
      platform: process.platform,
      wallTime: Number.isFinite(event.wallTime) ? event.wallTime : 0,
      monotonicTime: Number.isFinite(event.monotonicTime) ? event.monotonicTime : 0,
      sdkLanguage: 'javascript',
      options: {},
      contextId: '',
      title: 'Custom-server local sign-in smoke'
    };
  }

  if(!TRACE_ACTION_TYPES.has(event.type) || !safeEventId(event.callId)) return undefined;
  if(event.type === 'input') {
    if(!event.point || !Number.isFinite(event.point.x) || !Number.isFinite(event.point.y)) return undefined;
    return {type: 'input', callId: event.callId, point: {x: event.point.x, y: event.point.y}};
  }

  if(event.type === 'before') {
    const className = safeIdentifier(event.class) ? event.class : 'Playwright';
    const method = safeIdentifier(event.method) ? event.method : 'action';
    const isNamedPhase = (className === 'Tracing' && method === 'group') || (className === 'Test' && method === 'step');
    const title = isNamedPhase && safeGroupTitle(event.title) ?
      event.title : `${className}.${method}`;
    const result = {
      type: 'before',
      callId: event.callId,
      startTime: Number.isFinite(event.startTime) ? event.startTime : 0,
      title,
      class: className,
      method,
      params: {}
    };
    for(const name of ['parentId', 'pageId', 'stepId']) {
      if(safeEventId(event[name])) result[name] = event[name];
    }
    return result;
  }

  const result = {
    type: 'after',
    callId: event.callId,
    endTime: Number.isFinite(event.endTime) ? event.endTime : 0
  };
  if(event.error) {
    result.error = {
      name: 'Error',
      message: 'Failure details are in the sanitized error-context.md.'
    };
  }
  return result;
}

function sanitizeTrace(tracePath, destination) {
  const archive = unzipSync(readFileSync(tracePath));
  const traceNames = Object.keys(archive).filter((name) => name.endsWith('.trace') &&
    !name.startsWith('/') && !name.split('/').includes('..'));
  if(traceNames.length === 0) return false;

  const safeArchive = {};
  let actionCount = 0;
  for(const traceName of traceNames) {
    const rawEvents = strFromU8(archive[traceName]).split(/\r?\n/).filter(Boolean);
    const safeEvents = [];
    for(const rawEvent of rawEvents) {
      let event;
      try {
        event = JSON.parse(rawEvent);
      } catch {
        continue;
      }
      const safeEvent = safeTraceEvent(event);
      if(!safeEvent) continue;
      if(safeEvent.type === 'before') actionCount++;
      safeEvents.push(JSON.stringify(safeEvent));
    }
    if(safeEvents.length === 0) continue;
    safeArchive[traceName] = strToU8(`${safeEvents.join('\n')}\n`);
    safeArchive[traceName.replace(/\.trace$/, '.network')] = strToU8('');
  }

  if(actionCount === 0) return false;
  writeFileSync(destination, zipSync(safeArchive, {level: 6}), {mode: 0o600});
  return true;
}

function firstErrorLine(markdown) {
  const start = markdown.indexOf('# Error details');
  if(start < 0) return '';
  const section = markdown.slice(start).split(/\n# /, 1)[0];
  const match = section.match(/```[^\n]*\n([\s\S]*?)\n```/);
  return match?.[1]?.split(/\r?\n/, 1)[0] || '';
}

function failureSummary(errorText) {
  const line = firstErrorLine(errorText) || errorText.split(/\r?\n/, 1)[0] || '';
  const timeout = line.match(/(?:timeout|timed out)[^\n]*?(\d+)\s*ms/i) || line.match(/Timeout (\d+)ms/i);
  if(timeout) return `Playwright timed out during a browser operation (${timeout[1]} ms).`;
  if(/timeout|timed out/i.test(line)) return 'Playwright timed out during a browser operation.';
  const matcher = line.match(/expect(?:\.poll)?\([^)]*\)\.(to[A-Za-z0-9_]+)/);
  if(matcher) return `A Playwright assertion failed (${matcher[1]}).`;
  if(line) return 'The custom-server browser test raised an error.';
  return 'Playwright recorded a failure without a readable error line.';
}

function reportErrorEntries(reportPath) {
  const contents = readFileIfRegular(reportPath);
  if(!contents) return [];

  let report;
  try {
    report = JSON.parse(contents);
  } catch {
    return [];
  }

  const entries = [];
  function visitSuite(suite) {
    for(const spec of suite.specs || []) {
      if(spec.title !== TEST_NAME || !String(spec.file || '').replaceAll('\\', '/').endsWith('e2e/customServerLocalSignIn.spec.ts')) continue;
      for(const test of spec.tests || []) {
        for(const result of test.results || []) {
          if(result.status === 'passed') continue;
          const errors = result.errors?.length ? result.errors : result.error ? [result.error] : [];
          for(const error of errors) {
            const location = error.location || result.error?.location;
            const line = Number.isSafeInteger(location?.line) && location.line > 0 ? location.line : undefined;
            const column = Number.isSafeInteger(location?.column) && location.column > 0 ? location.column : undefined;
            entries.push({
              location: `e2e/customServerLocalSignIn.spec.ts${line ? `:${line}${column ? `:${column}` : ''}` : ''}`,
              summary: failureSummary(typeof error.message === 'string' ? error.message : '')
            });
          }
        }
      }
    }
    for(const child of suite.suites || []) visitSuite(child);
  }

  for(const suite of report.suites || []) visitSuite(suite);
  return entries;
}

function sanitizedErrorContext(paths, reportEntries) {
  const entries = [
    ...reportEntries,
    ...paths.map((path) => {
      const markdown = readFileSync(path, 'utf8');
      const location = markdown.match(/^- Location: (?:.*?)(e2e\/customServerLocalSignIn\.spec\.ts:\d+:\d+)$/m)?.[1] ||
        'e2e/customServerLocalSignIn.spec.ts';
      return {location, summary: failureSummary(markdown)};
    })
  ];
  if(entries.length === 0) return undefined;
  const uniqueEntries = [...new Map(entries.map((entry) => [`${entry.location}:${entry.summary}`, entry])).values()];
  return [
    '# Custom-server browser failure context',
    '',
    `- Test: ${TEST_NAME}`,
    ...uniqueEntries.flatMap((entry, index) => [
      `- Failure ${index + 1} location: ${entry.location}`,
      `- Failure ${index + 1} summary: ${entry.summary}`
    ]),
    '',
    'Browser page state, user input, action arguments, network contents, and raw test source were excluded.'
  ].join('\n') + '\n';
}

function logField(line, name) {
  const jsonField = line.match(new RegExp(`"${name}"\\s*:\\s*"?([A-Za-z0-9_.-]{1,80})`, 'i'));
  if(jsonField) return jsonField[1];
  const textField = line.match(new RegExp(`\\b${name}=([A-Za-z0-9_.-]{1,80})`, 'i'));
  return textField?.[1];
}

function sanitizeServerLog(text) {
  const output = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  for(const line of lines) {
    const fields = [];
    const level = logField(line, 'level');
    const method = logField(line, 'rpc_method');
    const status = logField(line, 'status');
    const error = logField(line, 'error');
    const timestamp = line.match(/\b(?:time|ts|timestamp)[=:]\s*"?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?)/i)?.[1];
    if(timestamp) fields.push(`time=${timestamp}`);
    if(['DEBUG', 'INFO', 'WARN', 'ERROR'].includes((level || '').toUpperCase())) fields.push(`level=${level.toLowerCase()}`);
    if(method) fields.push(`rpc_method=${method}`);
    if(status && /^[1-5]\d\d$/.test(status)) fields.push(`status=${status}`);
    if(error) fields.push(`error=${SAFE_SERVER_ERROR_TYPES.has(error.toLowerCase()) ? error.toLowerCase() : 'present'}`);
    else if(/\berror\b|\bfailed\b|\bexception\b/i.test(line)) fields.push('error=present');
    if(fields.length) output.push(`server ${fields.join(' ')}`);
  }
  return {lineCount: lines.length, records: output.slice(-500)};
}

function sanitizeStartupLog(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const records = [];
  let startedStage;
  const successfulStages = new Set();
  for(const line of lines) {
    const match = line.match(/^stage=([a-z0-9_]+) result=(started|success)$/);
    if(match) {
      const [, stage, result] = match;
      records.push(`startup stage=${stage} result=${result}`);
      if(result === 'started') startedStage = stage;
      else {
        successfulStages.add(stage);
        if(startedStage === stage) startedStage = undefined;
      }
      continue;
    }

    const category = /connection refused|could not connect/i.test(line) ? 'connection_refused' :
      /timed out|timeout/i.test(line) ? 'timeout' :
        /permission denied/i.test(line) ? 'permission_denied' :
          /no such file|not found/i.test(line) ? 'missing_dependency' :
            /checksum|version mismatch/i.test(line) ? 'migration_state_mismatch' :
              /error|failed|fatal|cannot|invalid/i.test(line) ? 'command_failed' : undefined;
    if(category) records.push(`startup stage=${startedStage || 'unknown'} detail=${category}`);
  }
  if(startedStage && !successfulStages.has(startedStage)) records.push(`startup stage=${startedStage} result=incomplete`);
  return {lineCount: lines.length, records: records.slice(-100)};
}

function gitRevision(directory) {
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return /^[a-f0-9]{40}$/i.test(revision) ? revision : null;
  } catch {
    return null;
  }
}

function writeOutput(name, value) {
  if(process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

try {
  const runnerTemp = process.env.RUNNER_TEMP;
  const testOutputDirectory = process.env.TWEB_PRIVATE_AUTH_OUTPUT_DIR;
  const reportPath = process.env.TWEB_PRIVATE_AUTH_JSON_REPORT;
  if(!runnerTemp || !isAbsolute(runnerTemp)) throw new Error('runner temporary directory is unavailable');
  if(testOutputDirectory && (!isAbsolute(testOutputDirectory) || !isInside(runnerTemp, testOutputDirectory))) {
    throw new Error('browser output directory is outside the runner temporary directory');
  }
  if(reportPath && (!isAbsolute(reportPath) || !isInside(runnerTemp, reportPath))) {
    throw new Error('browser report is outside the runner temporary directory');
  }

  const testFiles = findTestArtifacts(testOutputDirectory);
  const rawContexts = testFiles.filter((path) => basename(path) === 'error-context.md');
  const rawTraces = testFiles.filter((path) => basename(path) === 'trace.zip');
  const startupText = readFileIfRegular(process.env.TEAGRAMD_STARTUP_LOG_FILE) || '';
  const serverText = readFileIfRegular(process.env.TEAGRAMD_LOG_FILE) || '';
  const startupLog = sanitizeStartupLog(startupText);
  const serverLog = sanitizeServerLog(serverText);
  const reportEntries = reportErrorEntries(reportPath);
  const hasEvidence = testFiles.length > 0 || regularFile(reportPath) || regularFile(process.env.TEAGRAMD_STARTUP_LOG_FILE) ||
    regularFile(process.env.TEAGRAMD_LOG_FILE);
  if(reportPath && regularFile(reportPath)) rmSync(reportPath, {force: true});
  if(!hasEvidence) {
    writeOutput('artifact_ready', 'false');
    process.stdout.write('[custom-server-smoke] no fixture or browser evidence was available\n');
  } else {
    const artifactDirectory = mkdtempSync(join(runnerTemp, 'teagram-custom-server-evidence-'));
    const traceFiles = [];
    let traceFailureCount = 0;
    for(const [index, rawTrace] of rawTraces.entries()) {
      const outputName = rawTraces.length === 1 ? 'trace.zip' : `trace-${index + 1}.zip`;
      try {
        if(sanitizeTrace(rawTrace, join(artifactDirectory, outputName))) traceFiles.push(outputName);
        else traceFailureCount++;
      } catch {
        traceFailureCount++;
      }
    }

    const context = sanitizedErrorContext(rawContexts, reportEntries);
    const browserOutcome = process.env.TWEB_CUSTOM_SERVER_SMOKE_OUTCOME || 'not-run';
    const startupOutcome = process.env.TWEB_STARTUP_OUTCOME || 'not-run';
    const migrationOutcome = process.env.TWEB_MIGRATION_OUTCOME || 'not-run';
    if(context) writeFileSync(join(artifactDirectory, 'error-context.md'), context, {mode: 0o600});
    else if(browserOutcome === 'failure') {
      writeFileSync(join(artifactDirectory, 'error-context.md'), [
        '# Custom-server browser failure context',
        '',
        `- Test: ${TEST_NAME}`,
        '- Failure: Playwright failed without retaining its error-context file.',
        ''
      ].join('\n'), {mode: 0o600});
    }

    const fixtureLog = [
      '# Sanitized disposable Teagram server fixture logs',
      '# Raw output and unrecognized fields are excluded.',
      `startup lines observed=${startupLog.lineCount}`,
      `startup safe records=${startupLog.records.length}`,
      `server lines observed=${serverLog.lineCount}`,
      `server safe records=${serverLog.records.length}`,
      ...startupLog.records,
      ...serverLog.records
    ].join('\n') + '\n';
    writeFileSync(join(artifactDirectory, 'fixture.log'), fixtureLog, {mode: 0o600});

    const browserTraceReason = traceFiles.length > 0 ? null :
      browserOutcome === 'not-run' || browserOutcome === 'skipped' ? 'The browser scenario did not run.' :
        traceFailureCount > 0 ? 'Playwright trace data was unavailable or could not be sanitized.' :
          'Playwright did not retain a failed custom-server browser trace.';
    const manifest = {
      web_sha: gitRevision(process.env.GITHUB_WORKSPACE || ROOT_DIRECTORY),
      server_sha: gitRevision(join(process.env.GITHUB_WORKSPACE || ROOT_DIRECTORY, 'teagram-server')),
      run_id: process.env.GITHUB_RUN_ID || null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
      fixture_migration_outcome: migrationOutcome,
      fixture_startup_outcome: startupOutcome,
      browser_smoke_outcome: browserOutcome,
      browser_trace_available: traceFiles.length > 0,
      browser_trace_files: traceFiles,
      browser_trace_unavailable_reason: browserTraceReason,
      error_context_available: rawContexts.length > 0,
      fixture_log_files_observed: [
        ...(regularFile(process.env.TEAGRAMD_STARTUP_LOG_FILE) ? ['startup'] : []),
        ...(regularFile(process.env.TEAGRAMD_LOG_FILE) ? ['server'] : [])
      ],
      trace_sanitization_failures: traceFailureCount
    };
    writeFileSync(join(artifactDirectory, 'run-metadata.json'), `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600});

    for(const rawFile of testFiles) rmSync(rawFile, {force: true});
    writeOutput('artifact_ready', 'true');
    writeOutput('artifact_path', artifactDirectory);
    process.stdout.write(`[custom-server-smoke] safe evidence staged; trace_available=${manifest.browser_trace_available}\n`);
  }
} catch(error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'failed to collect custom-server smoke evidence'}\n`);
  process.exitCode = 1;
}
