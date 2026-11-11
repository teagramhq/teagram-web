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

export function injectSearchRpcTracer(source) {
  let result = source;
  result = replaceOnce(
    result,
    "    if(import.meta.env.VITE_PERF_TRACE === '1') {\n      this.performanceRpcTrace = new PerformanceRpcTrace(true);\n    }",
    "    if(import.meta.env.VITE_PERF_TRACE === '1' || import.meta.env.VITE_PERF_SEARCH_TRACE === '1') {\n      this.performanceRpcTrace = new PerformanceRpcTrace(true);\n    }",
    'the RPC trace initialization'
  );
  result = replaceOnce(
    result,
    "    if(import.meta.env.VITE_PERF_TRACE === '1') this.performanceRpcTrace!.reset(recordSpans);",
    "    if(import.meta.env.VITE_PERF_TRACE === '1' || import.meta.env.VITE_PERF_SEARCH_TRACE === '1') {\n      this.performanceRpcTrace!.reset(recordSpans);\n    }",
    'the RPC trace reset'
  );
  result = replaceOnce(
    result,
    "    if(import.meta.env.VITE_PERF_TRACE === '1') this.performanceRpcTrace?.recordCall(methodName);",
    "    if(import.meta.env.VITE_PERF_TRACE === '1') this.performanceRpcTrace?.recordCall(methodName);\n    const traceSearch = import.meta.env.VITE_PERF_SEARCH_TRACE === '1' && methodName === 'messages.searchGlobal';",
    'the invoke call trace hook'
  );
  result = replaceOnce(
    result,
    '      return this.invokeApiInternal(method, params, options);',
    '      const request = this.invokeApiInternal(method, params, options);\n      return traceSearch ? this.performanceRpcTrace?.trackWait(methodName, request) ?? request : request;',
    'the unauthenticated RPC return hook'
  );
  return result;
}

if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if(process.argv.length !== 3) throw new Error('Usage: node inject-search-rpc-tracer.mjs <apiManager.ts>');
  const path = process.argv[2];
  const source = readFileSync(path, 'utf8');
  writeFileSync(path, injectSearchRpcTracer(source));
}
