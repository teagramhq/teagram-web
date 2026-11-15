import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

function replaceOnce(source, befores, after, description) {
  const matches = befores.flatMap((before) => {
    const offsets = occurrenceOffsets(source, before);
    return offsets.length ? [{before, offsets}] : [];
  }).sort((left, right) => right.before.length - left.before.length);
  if(!matches.length) throw new Error(`Cannot inject search RPC tracer: missing ${description}`);
  const {before, offsets} = matches[0];
  if(offsets.length !== 1) {
    throw new Error(`Cannot inject search RPC tracer: ${description} is ambiguous`);
  }
  const start = source.indexOf(before);
  const end = start + before.length;
  if(matches.slice(1).some(({before: nested, offsets: nestedOffsets}) => (
    nestedOffsets.some((offset) => offset < start || offset + nested.length > end)
  ))) {
    throw new Error(`Cannot inject search RPC tracer: ${description} is ambiguous`);
  }
  return source.slice(0, start) + after + source.slice(start + before.length);
}

function occurrenceOffsets(source, needle) {
  const offsets = [];
  let offset = 0;
  while((offset = source.indexOf(needle, offset)) >= 0) {
    offsets.push(offset);
    offset += needle.length;
  }
  return offsets;
}

function countOccurrences(source, needle) {
  return occurrenceOffsets(source, needle).length;
}

const replacements = [
  {
    before: ["import {PerformanceRpcTrace, performancePhaseTrace} from '@appManagers/performanceTrace';\n\n"],
    after: "import {PerformanceRpcTrace, performancePhaseTrace} from '@appManagers/performanceTrace';\nimport {trackHistoryPerformanceRpc} from '@appManagers/performanceHistoryTrace';\n\n",
    description: 'the history trace import'
  },
  {
    before: [
      '    if(import.meta.env.VITE_PERF_TRACE === \'1\') {\n      this.performanceRpcTrace = new PerformanceRpcTrace(true);\n    }',
      '    if(import.meta.env.VITE_PERF_TRACE === \'1\' || import.meta.env.VITE_PERF_SEARCH_TRACE === \'1\') {\n      this.performanceRpcTrace = new PerformanceRpcTrace(true);\n    }'
    ],
    after: '    if(import.meta.env.VITE_PERF_TRACE === \'1\' || import.meta.env.VITE_PERF_SEARCH_TRACE === \'1\' || import.meta.env.VITE_PERF_HISTORY_TRACE === \'1\') {\n      this.performanceRpcTrace = new PerformanceRpcTrace(true);\n    }',
    description: 'the RPC trace initialization'
  },
  {
    before: [
      '    if(import.meta.env.VITE_PERF_TRACE === \'1\') this.performanceRpcTrace!.reset(recordSpans);',
      '    if(import.meta.env.VITE_PERF_TRACE === \'1\' || import.meta.env.VITE_PERF_SEARCH_TRACE === \'1\') {\n      this.performanceRpcTrace!.reset(recordSpans);\n    }'
    ],
    after: '    if(import.meta.env.VITE_PERF_TRACE === \'1\' || import.meta.env.VITE_PERF_SEARCH_TRACE === \'1\' || import.meta.env.VITE_PERF_HISTORY_TRACE === \'1\') {\n      this.performanceRpcTrace!.reset(recordSpans);\n    }',
    description: 'the RPC trace reset'
  },
  {
    before: ["    return import.meta.env.VITE_PERF_TRACE === '1' ?\n      this.performanceRpcTrace?.trackWait(method, request) ?? request :\n      request;"],
    after: "    const traceHistory = import.meta.env.VITE_PERF_HISTORY_TRACE === '1' && method === 'messages.getHistory';\n    return import.meta.env.VITE_PERF_TRACE === '1' && !traceHistory ?\n      this.performanceRpcTrace?.trackWait(method, request) ?? request :\n      request;",
    description: 'the wrapped RPC wait trace'
  },
  {
    before: [
      '    if(import.meta.env.VITE_PERF_TRACE === \'1\') this.performanceRpcTrace?.recordCall(methodName);',
      '    if(import.meta.env.VITE_PERF_TRACE === \'1\') this.performanceRpcTrace?.recordCall(methodName);\n    const traceSearch = import.meta.env.VITE_PERF_SEARCH_TRACE === \'1\' && methodName === \'messages.searchGlobal\';'
    ],
    after: '    const traceHistory = import.meta.env.VITE_PERF_HISTORY_TRACE === \'1\' && methodName === \'messages.getHistory\';\n    if(import.meta.env.VITE_PERF_TRACE === \'1\' || traceHistory) this.performanceRpcTrace?.recordCall(methodName);\n    const traceSearch = import.meta.env.VITE_PERF_SEARCH_TRACE === \'1\' && methodName === \'messages.searchGlobal\';',
    description: 'the invoke call trace hook'
  },
  {
    before: [
      '      return this.invokeApiInternal(method, params, options);',
      '      const request = this.invokeApiInternal(method, params, options);\n      return traceSearch ? this.performanceRpcTrace?.trackWait(methodName, request) ?? request : request;',
      '      const request = this.invokeApiInternal(method, params, options);\n      return traceSearch || traceHistory ? this.performanceRpcTrace?.trackWait(methodName, request) ?? request : request;'
    ],
    after: '      const request = this.invokeApiInternal(method, params, options);\n      return traceHistory ? trackHistoryPerformanceRpc(this.performanceRpcTrace, request, params) :\n        traceSearch ? this.performanceRpcTrace?.trackWait(methodName, request) ?? request : request;',
    description: 'the unauthenticated RPC return hook'
  },
  {
    before: [
      '      request.then(() => redactor.end(), () => redactor.end());\n      return request;',
      '      request.then(() => redactor.end(), () => redactor.end());\n      return traceHistory ? this.performanceRpcTrace?.trackWait(methodName, request) ?? request : request;'
    ],
    after: '      request.then(() => redactor.end(), () => redactor.end());\n      return traceHistory ? trackHistoryPerformanceRpc(this.performanceRpcTrace, request, params) : request;',
    description: 'the authenticated RPC return hook'
  }
];

export function injectSearchRpcTracer(source) {
  let result = source;
  for(const {before, after, description} of replacements) {
    const count = countOccurrences(result, after);
    if(count > 1) throw new Error('Cannot inject search RPC tracer: already instrumented source has unexpected or ambiguous hooks');
    if(count === 1) {
      const start = result.indexOf(after);
      const end = start + after.length;
      if(before.some((anchor) => occurrenceOffsets(result, anchor).some((offset) => offset < start || offset + anchor.length > end))) {
        throw new Error('Cannot inject search RPC tracer: already instrumented source has unexpected or ambiguous hooks');
      }
    } else {
      result = replaceOnce(result, before, after, description);
    }
  }
  return result;
}

if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if(process.argv.length !== 3) throw new Error('Usage: node inject-search-rpc-tracer.mjs <apiManager.ts>');
  const path = process.argv[2];
  const source = readFileSync(path, 'utf8');
  writeFileSync(path, injectSearchRpcTracer(source));
}
