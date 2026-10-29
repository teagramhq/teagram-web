import {execFileSync} from 'node:child_process';
import {chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {isIPv4} from 'node:net';

import {
  assertAllScenariosPassed,
  expectedScreenshotCount,
  formatBrowserFailureMessage,
  parsePassedBrowserGateBreakdown,
  parseChannelMembershipState,
  POLL_NEGATIVE_CONTROL_EVIDENCE,
  REQUIRED_CONTROLS,
  parseFixtureReadiness,
  parseAuthProgressReport,
  parseObserverControls,
  parsePasswordEvidence,
  parseRealClientArgs,
  parseWorkerObservation,
  readSyntheticCredentials
} from './contract.mjs';

const HELP = `Usage: pnpm run test:real-client -- --readiness-file <jsonl> --harness-revision <sha> --server-revision <sha> --web-revision <sha> --run-id <hex> (--scenarios <scenario-list> | --auth-progress-one-submission) [--page-error-diagnostics]

For the legacy poll regression control, add --poll-creation-negative-control and pin the pre-MAIN-2111 server revision.

The fixture must remain running after artifact-ready. The command validates its immutable pins,
protected synthetic credentials, internal browser network, audited artifact evidence, per-context
shared-worker observation, sign-in/first-message/message/group plus independently optional channel, poll and guest-signup scenarios,
or one bounded Username submission. The opt-in page-error diagnostics include bounded, sanitized
source frames, private page path, fixed scenario and stage labels, and optional RPC error type/code.
Raw page-error messages and stack text are never serialized.
The one-submission mode stops at password-field readiness without entering or submitting a password.`;
const NETWORK_SOURCES = ['page', 'shared_worker', 'service_worker', 'worker'];

function hasNetworkSourceEvidence(context) {
  if(!context || !Number.isSafeInteger(context.allowedWebSockets) || context.allowedWebSockets < 1) return false;
  for(const source of NETWORK_SOURCES) {
    const attempts = context.attemptsBySource?.[source];
    const unexpected = context.unexpectedAttemptsBySource?.[source];
    const webSockets = context.allowedWebSocketsBySource?.[source];
    if(!Number.isSafeInteger(attempts) || attempts < 0 ||
        !Number.isSafeInteger(unexpected) || unexpected < 0 || unexpected > attempts ||
        !Number.isSafeInteger(webSockets) || webSockets < 0 || webSockets > attempts) {
      return false;
    }
  }
  return true;
}

let args;
try {
  args = parseRealClientArgs(process.argv.slice(2));
} catch(error) {
  process.stderr.write(`${error?.message || 'invalid command line'}\n`);
  process.exitCode = 2;
}

if(args?.help) {
  process.stdout.write(`${HELP}\n`);
} else if(args) {
  let cleanupError;
  let operationError;
  let browserScriptInstalled = false;
  let observerScriptInstalled = false;
  let browserContainerValidated = false;
  let browserResult;
  let passwordEvidence = [];
  let readiness;
  let traceOutputDirectory;
  let controlsOnlyDone = false;
  let authProgressFailure = false;

  const docker = (dockerArgs, input, stage, timeout = 30_000) => {
    try {
      return execFileSync('docker', dockerArgs, {
        encoding: 'utf8',
        input,
        maxBuffer: 16 * 1024 * 1024,
        timeout,
        windowsHide: true
      });
    } catch(error) {
      const failure = new Error(`${stage} failed`);
      if(typeof error?.stdout === 'string' || Buffer.isBuffer(error?.stdout)) failure.stdout = error.stdout;
      throw failure;
    }
  };

  const dockerBytes = (dockerArgs, stage, timeout = 30_000) => {
    try {
      return execFileSync('docker', dockerArgs, {
        encoding: null,
        maxBuffer: 52 * 1024 * 1024,
        timeout,
        windowsHide: true
      });
    } catch {
      throw new Error(`${stage} failed`);
    }
  };

  try {
    if(process.env.REAL_CLIENT_TRACE_DIR) {
      if(!isAbsolute(process.env.REAL_CLIENT_TRACE_DIR)) throw new Error('trace output directory must be absolute');
      traceOutputDirectory = resolve(process.env.REAL_CLIENT_TRACE_DIR);
      mkdirSync(traceOutputDirectory, {recursive: true, mode: 0o700});
      const traceDirectoryStat = lstatSync(traceOutputDirectory);
      if(!traceDirectoryStat.isDirectory() || traceDirectoryStat.isSymbolicLink() || readdirSync(traceOutputDirectory).length > 0) {
        throw new Error('trace output directory must be a new empty directory');
      }
      chmodSync(traceOutputDirectory, 0o700);
    }

    const controlsOnly = args.observerControlsOnly === true;
    const authProgress = args.authProgressOneSubmission === true;
    const readinessText = readFileSync(resolve(args.readinessFile), 'utf8');
    readiness = parseFixtureReadiness(readinessText, {
      runId: args.runId,
      harnessRevision: args.harnessRevision,
      serverRevision: args.serverRevision,
      webRevision: args.webRevision
    }, {requireArtifact: !controlsOnly});
    const {serverReady, artifactReady} = readiness;
    const credentials = readSyntheticCredentials(serverReady.credentials, args.runId, authProgress ? 1 : 2);

    if(!/^[A-Za-z0-9+/]{43}=$/.test(serverReady.leafSPKI || '') ||
        Buffer.from(serverReady.leafSPKI, 'base64').byteLength !== 32) {
      throw new Error('fixture TLS SPKI pin is invalid');
    }

    const prefix = `teagram-fixture-${args.runId}`;
    const browserName = `${prefix}browser`;
    const frontName = `${prefix}tls-front`;
    const edgeName = `${prefix}edge`;
    const serverName = `${prefix}server`;
    const inspect = (name, stage) => JSON.parse(docker(['inspect', '--format', '{{json .}}', name], undefined, stage));
    const browser = inspect(browserName, 'fixture browser inspection');
    const front = inspect(frontName, 'fixture TLS front inspection');
    const edge = JSON.parse(docker(['network', 'inspect', '--format', '{{json .}}', edgeName], undefined, 'fixture edge network inspection'));
    const server = JSON.parse(docker(['network', 'inspect', '--format', '{{json .}}', serverName], undefined, 'fixture server network inspection'));
    const browserNetworks = browser.NetworkSettings?.Networks || {};
    const frontNetworks = front.NetworkSettings?.Networks || {};
    const browserLabels = browser.Config?.Labels || {};
    const frontLabels = front.Config?.Labels || {};
    const runLabel = 'org.teagram.fixture.run';
    const browserPortBindings = browser.HostConfig?.PortBindings;
    const frontPortBindings = front.HostConfig?.PortBindings;
    const browserEnvironment = browser.Config?.Env || [];
    const frontEnvironment = front.Config?.Env || [];
    const proxyEnvironment = browserEnvironment.filter((entry) => /^(http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|all_proxy|NO_PROXY|no_proxy)=/i.test(entry));
    const leakedRuntimeEnvironment = browserEnvironment.some((entry) => /^(TG_|MTPROTO_)/.test(entry));
    const leakedFrontRuntimeEnvironment = frontEnvironment.some((entry) => /^(TG_|MTPROTO_)/.test(entry));
    const unsafeMounts = [...(browser.Mounts || []), ...(front.Mounts || [])].some((mount) => mount.Type !== 'tmpfs');
    const securityOptions = browser.HostConfig?.SecurityOpt || [];

    if(browserLabels[runLabel] !== args.runId || frontLabels[runLabel] !== args.runId ||
        edge.Labels?.[runLabel] !== args.runId || server.Labels?.[runLabel] !== args.runId ||
        edge.Internal !== true || server.Internal !== true || edge.EnableIPv6 !== false || server.EnableIPv6 !== false ||
        Object.keys(browserNetworks).length !== 1 || !browserNetworks[edgeName] ||
        !frontNetworks[edgeName] || !frontNetworks[serverName] || Object.keys(frontNetworks).length !== 2 ||
        browser.HostConfig?.NetworkMode !== edgeName || browser.HostConfig?.ReadonlyRootfs !== true ||
        browser.Config?.User !== '1001:1001' || browser.HostConfig?.Privileged === true || !browser.HostConfig?.CapDrop?.includes('ALL') ||
        !securityOptions.includes('no-new-privileges:true') || !securityOptions.some((value) => value.startsWith('seccomp=')) ||
        (browserPortBindings && Object.keys(browserPortBindings).length > 0) ||
        front.HostConfig?.NetworkMode !== edgeName || front.Config?.User !== '1001:1001' ||
        front.HostConfig?.ReadonlyRootfs !== true || front.HostConfig?.Privileged === true ||
        !front.HostConfig?.CapDrop?.includes('ALL') ||
        !(front.HostConfig?.SecurityOpt || []).includes('no-new-privileges:true') ||
        (frontPortBindings && Object.keys(frontPortBindings).length > 0) ||
        proxyEnvironment.some((entry) => entry.split('=', 2)[1] !== '') ||
        leakedRuntimeEnvironment || leakedFrontRuntimeEnvironment || unsafeMounts) {
      throw new Error('fixture browser isolation does not match the accepted contract');
    }
    browserContainerValidated = true;

    const frontIp = frontNetworks[edgeName].IPAddress;
    if(!isIPv4(frontIp)) {
      throw new Error('fixture TLS front address is invalid');
    }

    const ipv4Routes = docker(['exec', browserName, 'cat', '/proc/net/route'], undefined, 'fixture browser IPv4 route check');
    const hasIpv4DefaultRoute = ipv4Routes.split(/\r?\n/).slice(1).some((line) => line.trim().split(/\s+/)[1] === '00000000');
    const ipv6Routes = docker(['exec', browserName, 'cat', '/proc/net/ipv6_route'], undefined, 'fixture browser IPv6 route check');
    const hasIpv6DefaultRoute = ipv6Routes.split(/\r?\n/).some((line) => {
      const fields = line.trim().split(/\s+/);
      if(fields.length < 10 || fields[0] !== '00000000000000000000000000000000' || fields[1] !== '00') return false;
      return fields[9] !== 'lo' || (Number.parseInt(fields[8], 16) & 512) === 0;
    });
    if(hasIpv4DefaultRoute || hasIpv6DefaultRoute) {
      throw new Error('fixture browser has a default network route');
    }

    const sourceDirectory = dirname(fileURLToPath(import.meta.url));
    const browserScript = readFileSync(resolve(sourceDirectory, 'browser.cjs'));
    const observerScript = readFileSync(resolve(sourceDirectory, 'observation.cjs'));
    const screenshotDirectory = `/tmp/real-client-${args.runId}`;
    // The staged scripts live beside, never inside, the screenshot directory:
    // the browser script creates that directory itself and must find it absent.
    const remoteDirectory = `/tmp/real-client-${args.runId}-runner`;
    const remoteScript = `${remoteDirectory}/runner.cjs`;
    const remoteObserverScript = `${remoteDirectory}/observation.cjs`;
    docker(['exec', browserName, '/bin/sh', '-c', `umask 077; mkdir -p ${remoteDirectory}`], undefined, 'browser runner staging');
    browserScriptInstalled = true;
    docker(['exec', '-i', browserName, '/bin/sh', '-c', `umask 077; cat > ${remoteScript}`], browserScript, 'browser runner staging');
    docker(['exec', '-i', browserName, '/bin/sh', '-c', `umask 077; cat > ${remoteObserverScript}`], observerScript, 'shared-worker observer staging');
    observerScriptInstalled = true;

    const browserInput = JSON.stringify({
      ...(controlsOnly ? {observationOnly: true} : {}),
      ...(authProgress ? {authProgressOneSubmission: true} : {}),
      ...(args.pageErrorDiagnostics === true ? {pageErrorDiagnostics: true} : {}),
      ...(args.pollCreationNegativeControl === true ? {pollCreationNegativeControl: true} : {}),
      ...(Array.isArray(args.scenarios) ? {scenarios: args.scenarios} : {}),
      runId: args.runId,
      endpoint: serverReady.endpoint,
      wssEndpoint: serverReady.wssEndpoint,
      fingerprint: serverReady.fingerprint,
      publicKeySHA256: serverReady.publicKeySHA256,
      artifactDigest: controlsOnly ? null : artifactReady.artifactDigest,
      manifestArtifactDigest: controlsOnly ? null : artifactReady.manifestArtifactDigest,
      leafSPKI: serverReady.leafSPKI,
      webRevision: args.webRevision,
      frontIp,
      screenshotDirectory,
      ...(traceOutputDirectory ? {traceDirectory: `/tmp/real-client-traces-${args.runId}`} : {}),
      accounts: credentials
    });
    let browserOutput;
    try {
      browserOutput = docker(
        ['exec', '-i', browserName, 'node', remoteScript],
        browserInput,
        'isolated browser scenarios',
        12 * 60_000
      );
    } catch(error) {
      const browserStdout = typeof error?.stdout === 'string' ? error.stdout :
        Buffer.isBuffer(error?.stdout) ? error.stdout.toString('utf8') : '';
      if(authProgress) {
        try {
          browserResult = parseAuthProgressReport(JSON.parse(browserStdout.trim()));
          if(browserResult.status !== 'failed') throw new Error('auth progress browser exit status is invalid');
          authProgressFailure = true;
        } catch {
          throw new Error('isolated auth progress runner failed');
        }
      } else {
        try {
          const failedRun = JSON.parse(browserStdout.trim());
          if(failedRun.status === 'failed' && typeof failedRun.stage === 'string') {
            browserResult = failedRun;
            throw new Error(formatBrowserFailureMessage(failedRun, controlsOnly));
          }
        } catch(parseError) {
          if(parseError instanceof Error && parseError.message.startsWith('real client scenario failed at ')) throw parseError;
        }
        throw error;
      }
    }
    if(!browserResult) {
      try {
        browserResult = authProgress
          ? parseAuthProgressReport(JSON.parse(browserOutput.trim()))
          : JSON.parse(browserOutput.trim());
      } catch {
        throw new Error(authProgress ? 'isolated auth progress runner returned an invalid report' : 'isolated browser returned an invalid report');
      }
      if(authProgress && browserResult.status === 'failed') authProgressFailure = true;
    }

    if(authProgress) {
      if(browserResult.status !== 'passed' && browserResult.status !== 'failed') {
        throw new Error('auth progress browser status is invalid');
      }
    } else if(browserResult.status !== 'passed') {
      throw new Error(formatBrowserFailureMessage(browserResult, controlsOnly));
    }
    if(authProgressFailure) {
      controlsOnlyDone = true;
    } else if(authProgress) {
      if(browserResult.mode !== 'auth_progress_one_submission') {
        throw new Error('browser report did not use one-submission mode');
      }
    } else if(controlsOnly) {
      if(browserResult.mode !== 'observer_controls' || browserResult.controlContextCount !== REQUIRED_CONTROLS.length ||
          browserResult.contextCount !== 0 || browserResult.screenshotsCaptured !== 0) {
        throw new Error('observer control run did not stay synthetic');
      }
      parseObserverControls(browserResult.workerObservation);
      controlsOnlyDone = true;
      process.stdout.write(`${JSON.stringify({
        status: 'passed',
        mode: 'observer_controls',
        runId: args.runId,
        harnessRevision: args.harnessRevision,
        serverRevision: args.serverRevision,
        webRevision: args.webRevision,
        controlContextCount: browserResult.controlContextCount,
        workerObservation: browserResult.workerObservation
      })}\n`);
    }
    if(!controlsOnlyDone && !authProgress) {
      passwordEvidence = parsePasswordEvidence(browserResult.passwordEvidence);
      if(JSON.stringify(passwordEvidence.map((entry) => entry.stage)) !== JSON.stringify([
        'alice_password_field_ready',
        'bob_password_field_ready'
      ])) {
        throw new Error('password readiness evidence is incomplete');
      }
      assertAllScenariosPassed(browserResult.scenarios, args.scenarios);
      if(args.scenarios.includes('channel')) {
        const channelMembership = parseChannelMembershipState(browserResult.channelMembership);
        if(channelMembership === 'unavailable' || channelMembership === 'unclassified' ||
            channelMembership.bob.channelRowCount !== 1 || channelMembership.bob.channelTitleMatches !== 1) {
          throw new Error('channel membership evidence is incomplete');
        }
        browserResult.channelMembership = channelMembership;
      }
      if(args.pollCreationNegativeControl === true) {
        if(JSON.stringify(browserResult.pollNegativeControl) !== JSON.stringify(POLL_NEGATIVE_CONTROL_EVIDENCE)) {
          throw new Error('poll creation negative control evidence is incomplete');
        }
      } else if(browserResult.pollNegativeControl !== undefined) {
        throw new Error('poll creation negative control evidence was unexpected');
      }
      browserResult.gateBreakdown = parsePassedBrowserGateBreakdown(browserResult);
      const expectedScreenshots = expectedScreenshotCount(args);
      const incompleteEvidence = [];
      if(browserResult.contextCount !== 2) incompleteEvidence.push('contexts');
      if(browserResult.screenshotsCaptured !== expectedScreenshots) {
        incompleteEvidence.push(`screenshots_${Number.isSafeInteger(browserResult.screenshotsCaptured) ? browserResult.screenshotsCaptured : 'unavailable'}_expected_${expectedScreenshots}`);
      }
      if(browserResult.network?.unexpectedAttempts !== 0) incompleteEvidence.push('unexpected_egress');
      if(browserResult.network?.observerErrors !== 0) incompleteEvidence.push('observer_errors');
      for(const account of ['alice', 'bob']) {
        const context = browserResult.network?.contexts?.[account];
        if(!hasNetworkSourceEvidence(context)) incompleteEvidence.push(`${account}_network_sources`);
        if(!Number.isSafeInteger(context?.workerTargets?.service_worker) || context.workerTargets.service_worker < 1) {
          incompleteEvidence.push(`${account}_service_worker`);
        }
      }
      if(incompleteEvidence.length > 0) {
        throw new Error(`real client UI or page/worker egress evidence is incomplete (${incompleteEvidence.join(',')})`);
      }
      // The page-session observer cannot see shared workers, so the shared-worker
      // evidence is the browser-level observation block: synthetic controls, per-context
      // attribution by browser context, and complete coverage.
      parseWorkerObservation(browserResult.workerObservation);
    }
  } catch(error) {
    operationError = error;
  } finally {
    if(browserResult?.status === 'failed' && browserResult.failureTraceReady === true && traceOutputDirectory && browserContainerValidated) {
      try {
        const browserName = `teagram-fixture-${args.runId}browser`;
        const traceRoot = `/tmp/real-client-traces-${args.runId}`;
        const traceListing = docker(['exec', browserName, 'find', traceRoot, '-maxdepth', '1', '-type', 'f', '-printf', '%f\\n'], undefined, 'Playwright failure trace inspection');
        const availableTraceFiles = new Set(traceListing.split(/\r?\n/).filter((name) => /^[a-z]+\.zip$/.test(name)));
        const traceFiles = [];
        for(const name of ['alice', 'bob']) {
          if(!availableTraceFiles.has(`${name}.zip`)) continue;
          const traceBytes = dockerBytes(['exec', browserName, 'cat', `${traceRoot}/${name}.zip`], 'Playwright failure trace export');
          writeFileSync(join(traceOutputDirectory, `${name}.zip`), traceBytes, {mode: 0o600, flag: 'wx'});
          traceFiles.push(`${name}.zip`);
        }
        const entries = readdirSync(traceOutputDirectory);
        if(traceFiles.length === 0 || JSON.stringify([...traceFiles].sort()) !== JSON.stringify(entries.sort())) {
          const observedFiles = traceListing.split(/\r?\n/).filter((name) => /^[a-z0-9_.-]+$/.test(name)).slice(0, 24);
          throw new Error(`browser assertion failure produced no Playwright trace (browser files: ${observedFiles.join(',') || 'none'})`);
        }
        for(const name of traceFiles) {
          const tracePath = join(traceOutputDirectory, name);
          const fileStat = lstatSync(tracePath);
          if(!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size < 4 || fileStat.size > 50 * 1024 * 1024 ||
              readFileSync(tracePath).subarray(0, 4).toString('hex') !== '504b0304') {
            throw new Error('Playwright failure trace is invalid');
          }
        }
        writeFileSync(join(traceOutputDirectory, 'trace-manifest.json'), `${JSON.stringify({
          status: 'browser-assertion-failed',
          runId: args.runId,
          harnessRevision: args.harnessRevision,
          serverRevision: args.serverRevision,
          webRevision: args.webRevision,
          traces: traceFiles.sort()
        })}\n`, {mode: 0o600});
      } catch(error) {
        cleanupError ||= error instanceof Error ? error : new Error('Playwright failure trace export failed');
      }
    }
    if(browserContainerValidated) {
      const browserName = `teagram-fixture-${args.runId}browser`;
      const cleanupDirectories = [
        [`/tmp/real-client-${args.runId}`, 'screenshot cleanup'],
        ...(traceOutputDirectory ? [[`/tmp/real-client-traces-${args.runId}`, 'trace cleanup']] : [])
      ];
      for(const [directory, stage] of cleanupDirectories) {
        try {
          docker(['exec', browserName, 'rm', '-rf', '--', directory], undefined, stage);
        } catch {
          cleanupError ||= new Error(`${stage} failed`);
        }
      }
    }
    if(browserScriptInstalled || observerScriptInstalled) {
      try {
        const browserName = `teagram-fixture-${args.runId}browser`;
        docker(['exec', browserName, 'rm', '-rf', '--', `/tmp/real-client-${args.runId}-runner`], undefined, 'browser runner cleanup');
      } catch {
        cleanupError ||= new Error('browser runner cleanup failed');
      }
    }
  }

  if(args.authProgressOneSubmission === true && browserResult && !operationError) {
    const finalReport = {
      ...browserResult,
      ...(readiness ? {
        runId: args.runId,
        harnessRevision: args.harnessRevision,
        serverRevision: args.serverRevision,
        webRevision: args.webRevision,
        artifactSourceCommit: readiness.artifactReady.webRevision,
        artifactDigest: readiness.artifactReady.artifactDigest
      } : {})
    };
    if(cleanupError) {
      finalReport.status = 'failed';
      finalReport.stage = 'cleanup';
    }
    process.stdout.write(`${JSON.stringify(finalReport)}\n`);
    if(finalReport.status !== 'passed') process.exitCode = 1;
  } else if(cleanupError || operationError) {
    const errors = [operationError?.message, cleanupError?.message].filter((message) => typeof message === 'string');
    process.stderr.write(`${errors.join('; ') || 'real client runner failed'}\n`);
    process.exitCode = 1;
  } else if(!controlsOnlyDone) {

    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      runId: args.runId,
      harnessRevision: args.harnessRevision,
      serverRevision: args.serverRevision,
      webRevision: args.webRevision,
      artifactDigest: readiness?.artifactReady?.artifactDigest ?? null,
      artifactAuditChecks: readiness.artifactReady.auditChecks,
      controlledProbeEvidence: {
        workers: readiness.serverReady.evidence.workerProbes,
        observerControlledAttempts: readiness.serverReady.evidence.observerControlledAttempts,
        directTCP: readiness.serverReady.evidence.directTCP
      },
      scenarios: browserResult.scenarios,
      ...(browserResult.channelMembership ? {channelMembership: browserResult.channelMembership} : {}),
      ...(browserResult.pollSendResults ? {pollSendResults: browserResult.pollSendResults} : {}),
      ...(Array.isArray(browserResult.pollFooterTransitions) ? {pollFooterTransitions: browserResult.pollFooterTransitions} : {}),
      pollCreationNegativeControl: args.pollCreationNegativeControl === true,
      ...(args.pollCreationNegativeControl === true ? {pollNegativeControl: POLL_NEGATIVE_CONTROL_EVIDENCE} : {}),
      ...(browserResult.gateBreakdown ? {gateBreakdown: browserResult.gateBreakdown} : {}),
      contextCount: browserResult.contextCount,
      screenshotsCaptured: browserResult.screenshotsCaptured,
      passwordEvidence,
      network: browserResult.network,
      workerObservation: browserResult.workerObservation
    })}\n`);
  }
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`${error?.message || 'real client runner failed'}\n`);
  process.exitCode = 1;
});

process.on('unhandledRejection', (error) => {
  process.stderr.write(`${error?.message || 'real client runner failed'}\n`);
  process.exitCode = 1;
});
