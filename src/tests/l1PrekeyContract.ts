const UPGRADE_RESULTS = new Set(['101', '403', 'other_4xx', '5xx', 'network_error']);
const STAGE_RESULTS = new Set(['complete', 'proto_error', 'closed', 'timeout', 'malformed']);
const DH_REPLY_RESULTS = new Set(['ok', 'fail', 'proto_error', 'closed', 'timeout', 'malformed']);
const PROTOCOL_ERROR_CODES = new Set(['404', '429', '444', 'other']);
const RESULTS = new Set([
  'invalid_input',
  'already_stopped',
  'concurrency_limited',
  'interval_limited',
  'rate_limited',
  'unknown',
  'origin_rejected',
  'upgrade_refused',
  'server_error',
  'respq_protocol_error',
  'respq_closed',
  'respq_malformed',
  'respq_nonce_mismatch',
  'fingerprint_mismatch',
  'pq_invalid',
  'dh_protocol_error',
  'dh_reply_closed',
  'dh_reply_malformed',
  'dh_reply_refused',
  'dh_reply_nonce_mismatch',
  'dh_inner_malformed',
  'dh_inner_invalid',
  'dh_inner_valid'
]);
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type DiagnosticFields = {
  upgrade?: string,
  respq?: string,
  respq_nonce_match?: boolean,
  fingerprint_in_pinned_set?: boolean,
  pq_valid?: boolean,
  dh_reply?: string,
  proto_error_code?: string,
  dh_inner_valid?: boolean,
  close_1000_sent?: boolean,
  result?: string,
  source_ref?: string,
  deploy_ref?: string,
  run_ref?: string
};

function copyEnum(output: Record<string, string | boolean>, input: DiagnosticFields, key: keyof DiagnosticFields, values: Set<string>) {
  const value = input[key];
  if(typeof value === 'string' && values.has(value)) {
    output[key] = value;
  }
}

function copyBoolean(output: Record<string, string | boolean>, input: DiagnosticFields, key: keyof DiagnosticFields) {
  const value = input[key];
  if(typeof value === 'boolean') {
    output[key] = value;
  }
}

function copyReference(output: Record<string, string | boolean>, input: DiagnosticFields, key: keyof DiagnosticFields) {
  const value = input[key];
  if(typeof value === 'string' && REFERENCE_PATTERN.test(value)) {
    output[key] = value;
  } else {
    output[key] = 'unknown';
  }
}

export function serializeDiagnosticResult(input: DiagnosticFields | Record<string, unknown>) {
  const fields = input as DiagnosticFields;
  const output: Record<string, string | boolean> = {};

  copyEnum(output, fields, 'upgrade', UPGRADE_RESULTS);
  copyEnum(output, fields, 'respq', STAGE_RESULTS);
  copyBoolean(output, fields, 'respq_nonce_match');
  copyBoolean(output, fields, 'fingerprint_in_pinned_set');
  copyBoolean(output, fields, 'pq_valid');
  copyEnum(output, fields, 'dh_reply', DH_REPLY_RESULTS);
  copyEnum(output, fields, 'proto_error_code', PROTOCOL_ERROR_CODES);
  copyBoolean(output, fields, 'dh_inner_valid');
  copyBoolean(output, fields, 'close_1000_sent');
  copyEnum(output, fields, 'result', RESULTS);
  copyReference(output, fields, 'source_ref');
  copyReference(output, fields, 'deploy_ref');
  copyReference(output, fields, 'run_ref');

  if(!output.result) output.result = 'unknown';

  return output;
}
