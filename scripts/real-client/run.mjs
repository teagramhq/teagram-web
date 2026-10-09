import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {isIPv4} from 'node:net';

import {
  assertAllScenariosPassed,
  REQUIRED_CONTROLS,
  parseFixtureReadiness,
  parseObserverControls,
  parseRealClientArgs,
  parseWorkerObservation,
  readSyntheticCredentials
} from './contract.mjs';

const HELP = `Usage: pnpm run test:real-client -- --readiness-file <jsonl> --harness-revision <sha> --server-revision <sha> --web-revision <sha> --run-id <hex> --scenarios sign-in,message,group

The fixture must remain running after artifact-ready. The command validates its immutable pins,
protected synthetic credentials, internal browser network, audited artifact evidence, per-context
shared-worker observation, and all three required UI scenarios. It does not import browser storage
state or export screenshots or traces.`;
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
  let readiness;
  let controlsOnlyDone = false;

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

  try {
    const controlsOnly = args.observerControlsOnly === true;
    const readinessText = readFileSync(resolve(args.readinessFile), 'utf8');
    readiness = parseFixtureReadiness(readinessText, {
      runId: args.runId,
      harnessRevision: args.harnessRevision,
      serverRevision: args.serverRevision,
      webRevision: args.webRevision
    }, {requireArtifact: !controlsOnly});
    const {serverReady, artifactReady} = readiness;
    const credentials = readSyntheticCredentials(serverReady.credentials, args.runId);

    if(!/^[A-Za-z0-9+/]{43}=$/.test(serverReady.leafSPKI || '') ||
        Buffer.from(serverReady.leafSPKI, 'base64').byteLength !== 32) {
      throw new Error('fixture TLS SPKI pin is invalid');
    }

    const prefix = `telegram-fixture-${args.runId}`;
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
      runId: args.runId,
      endpoint: serverReady.endpoint,
      wssEndpoint: serverReady.wssEndpoint,
      fingerprint: serverReady.fingerprint,
      publicKeySHA256: serverReady.publicKeySHA256,
      artifactDigest: controlsOnly ? null : artifactReady.artifactDigest,
      leafSPKI: serverReady.leafSPKI,
      webRevision: args.webRevision,
      frontIp,
      screenshotDirectory,
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
      try {
        const failedRun = JSON.parse(browserStdout.trim());
        if(failedRun.status === 'failed' && typeof failedRun.stage === 'string') {
          throw new Error(`real client scenario failed at ${failedRun.stage}`);
        }
      } catch(parseError) {
        if(parseError instanceof Error && parseError.message.startsWith('real client scenario failed at ')) throw parseError;
      }
      throw error;
    }
    try {
      browserResult = JSON.parse(browserOutput.trim());
    } catch {
      throw new Error('isolated browser returned an invalid report');
    }

    if(browserResult.status !== 'passed') {
      throw new Error(`real client scenario failed at ${browserResult.stage || 'unknown stage'}`);
    }
    if(controlsOnly) {
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
    if(!controlsOnlyDone) {
      assertAllScenariosPassed(browserResult.scenarios);
      if(browserResult.contextCount !== 2 || browserResult.screenshotsCaptured !== 16 ||
          browserResult.network?.unexpectedAttempts !== 0 || browserResult.network?.observerErrors !== 0 ||
          ['alice', 'bob'].some((account) => {
            const context = browserResult.network?.contexts?.[account];
            return !hasNetworkSourceEvidence(context) ||
              !Number.isSafeInteger(context.workerTargets?.service_worker) || context.workerTargets.service_worker < 1;
          })) {
        throw new Error('real client UI or page/worker egress evidence is incomplete');
      }
      // The page-session observer cannot see shared workers, so the shared-worker
      // evidence is the browser-level observation block: synthetic controls, per-context
      // attribution by browser context, and complete coverage.
      parseWorkerObservation(browserResult.workerObservation);
    }
  } catch(error) {
    operationError = error;
  } finally {
    if(browserContainerValidated) {
      try {
        const browserName = `telegram-fixture-${args.runId}browser`;
        docker(['exec', browserName, 'rm', '-rf', '--', `/tmp/real-client-${args.runId}`], undefined, 'screenshot cleanup');
      } catch {
        cleanupError = new Error('screenshot cleanup failed');
      }
    }
    if(browserScriptInstalled || observerScriptInstalled) {
      try {
        const browserName = `telegram-fixture-${args.runId}browser`;
        docker(['exec', browserName, 'rm', '-rf', '--', `/tmp/real-client-${args.runId}-runner`], undefined, 'browser runner cleanup');
      } catch {
        cleanupError ||= new Error('browser runner cleanup failed');
      }
    }
  }

  if(cleanupError || operationError) {
    process.stderr.write(`${cleanupError?.message || operationError?.message || 'real client runner failed'}\n`);
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
      contextCount: browserResult.contextCount,
      screenshotsCaptured: browserResult.screenshotsCaptured,
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
