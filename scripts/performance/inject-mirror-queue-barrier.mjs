import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const mainMessagePortAnchor = '  setLogBufferEnabled: (enabled: boolean) => void,';
const mainMessagePortBarrier = '  mirrorQueueBarrier: (payload: void) => void,';
const indexWorkerAnchor = '  getLogs: () => getLogEntries(),';
const indexWorkerBarrier = [
  '  mirrorQueueBarrier: () => {',
  '    // This reply follows earlier worker-to-window mirror messages on the same MessagePort.',
  '  },'
].join('\n');

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function insertAfterUnique(source, anchor, insertion, description) {
  const count = countOccurrences(source, anchor);
  if(count !== 1) {
    const problem = count ? 'is ambiguous' : 'is missing';
    throw new Error(`Cannot inject mirror queue barrier: ${description} ${problem}`);
  }

  return source.replace(anchor, `${anchor}\n${insertion}`);
}

export function injectMirrorQueueBarrier(mainMessagePortSource, indexWorkerSource) {
  const hasMainMessagePortBarrier = countOccurrences(mainMessagePortSource, mainMessagePortBarrier);
  const hasIndexWorkerBarrier = countOccurrences(indexWorkerSource, indexWorkerBarrier);
  if(hasMainMessagePortBarrier === 1 && hasIndexWorkerBarrier === 1) {
    return {mainMessagePort: mainMessagePortSource, indexWorker: indexWorkerSource};
  }
  if(hasMainMessagePortBarrier || hasIndexWorkerBarrier) {
    throw new Error('Cannot inject mirror queue barrier: base worker sources are partially instrumented');
  }

  return {
    mainMessagePort: insertAfterUnique(
      mainMessagePortSource,
      mainMessagePortAnchor,
      mainMessagePortBarrier,
      'main worker message-port anchor'
    ),
    indexWorker: insertAfterUnique(
      indexWorkerSource,
      indexWorkerAnchor,
      `\n${indexWorkerBarrier}`,
      'base worker listener anchor'
    )
  };
}

if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if(process.argv.length !== 3) throw new Error('Usage: node inject-mirror-queue-barrier.mjs <base-worktree>');
  const baseDirectory = resolve(process.argv[2]);
  const mainMessagePortPath = resolve(baseDirectory, 'src/lib/mainWorker/mainMessagePort.ts');
  const indexWorkerPath = resolve(baseDirectory, 'src/lib/mainWorker/index.worker.ts');
  const injected = injectMirrorQueueBarrier(
    readFileSync(mainMessagePortPath, 'utf8'),
    readFileSync(indexWorkerPath, 'utf8')
  );
  writeFileSync(mainMessagePortPath, injected.mainMessagePort);
  writeFileSync(indexWorkerPath, injected.indexWorker);
}
