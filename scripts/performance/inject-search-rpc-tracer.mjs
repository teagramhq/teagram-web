import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

function replaceOnce(source, before, after, description) {
  const start = source.indexOf(before);
  if(start < 0) throw new Error(`Cannot inject search RPC tracer: missing ${description}`);
  if(source.indexOf(before, start + before.length) >= 0) {
    throw new Error(`Cannot inject search RPC tracer: ${description} is ambiguous`);
  }
  return source.slice(0, start) + after + source.slice(start + before.length);
}

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while((offset = source.indexOf(needle, offset)) >= 0) {
    count++;
    offset += needle.length;
  }
  return count;
}

const replacements = [
  {
    before: '    if(import.meta.env.VITE_PERF_TRACE === \'1\') {\n      this.performanceRpcTrace = new PerformanceRpcTrace(true);\n    }',
    after: '    if(import.meta.env.VITE_PERF_TRACE === \'1\' || import.meta.env.VITE_PERF_SEARCH_TRACE === \'1\' || import.meta.env.VITE_PERF_HISTORY_TRACE === \'1\') {\n      this.performanceRpcTrace = new PerformanceRpcTrace(true);\n    }',
    description: 'the RPC trace initialization'
  },
  {
    before: '    if(import.meta.env.VITE_PERF_TRACE === \'1\') this.performanceRpcTrace!.reset(recordSpans);',
    after: '    if(import.meta.env.VITE_PERF_TRACE === \'1\' || import.meta.env.VITE_PERF_SEARCH_TRACE === \'1\' || import.meta.env.VITE_PERF_HISTORY_TRACE === \'1\') {\n      this.performanceRpcTrace!.reset(recordSpans);\n    }',
    description: 'the RPC trace reset'
  },
  {
    before: '    if(import.meta.env.VITE_PERF_TRACE === \'1\') this.performanceRpcTrace?.recordCall(methodName);',
    after: '    const traceHistory = import.meta.env.VITE_PERF_HISTORY_TRACE === \'1\' && methodName === \'messages.getHistory\';\n    if(import.meta.env.VITE_PERF_TRACE === \'1\' || traceHistory) this.performanceRpcTrace?.recordCall(methodName);\n    const traceSearch = import.meta.env.VITE_PERF_SEARCH_TRACE === \'1\' && methodName === \'messages.searchGlobal\';',
    description: 'the invoke call trace hook'
  },
  {
    before: '      return this.invokeApiInternal(method, params, options);',
    after: '      const request = this.invokeApiInternal(method, params, options);\n      return traceSearch || traceHistory ? this.performanceRpcTrace?.trackWait(methodName, request) ?? request : request;',
    description: 'the unauthenticated RPC return hook'
  },
  {
    before: '      request.then(() => redactor.end(), () => redactor.end());\n      return request;',
    after: '      request.then(() => redactor.end(), () => redactor.end());\n      return traceHistory ? this.performanceRpcTrace?.trackWait(methodName, request) ?? request : request;',
    description: 'the authenticated RPC return hook'
  }
];

export function injectSearchRpcTracer(source) {
  const injectedHookCounts = replacements.map(({after}) => countOccurrences(source, after));
  if(injectedHookCounts.every((count) => count === 1)) {
    const uninstrumentedHookCounts = replacements.map(({before}) => countOccurrences(source, before));
    const expectedUninstrumentedHookCounts = replacements.map(() => 0);
    if(uninstrumentedHookCounts.some((count, index) => count !== expectedUninstrumentedHookCounts[index])) {
      throw new Error('Cannot inject search RPC tracer: already instrumented source has unexpected or ambiguous hooks');
    }
    return source;
  }
  if(injectedHookCounts.some((count) => count > 0)) {
    throw new Error('Cannot inject search RPC tracer: source is partially instrumented or has ambiguous tracer hooks');
  }

  let result = source;
  for(const {before, after, description} of replacements) {
    result = replaceOnce(result, before, after, description);
  }
  return result;
}

if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if(process.argv.length !== 3) throw new Error('Usage: node inject-search-rpc-tracer.mjs <apiManager.ts>');
  const path = process.argv[2];
  const source = readFileSync(path, 'utf8');
  writeFileSync(path, injectSearchRpcTracer(source));
}
