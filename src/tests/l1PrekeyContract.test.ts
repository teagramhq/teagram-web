import {describe, expect, it} from 'vitest';
import {serializeDiagnosticResult} from './l1PrekeyContract';

const unknownReference = 'unknown';

describe('L1 pre-key diagnostic output contract', () => {
  it('keeps only observed allowlisted fields and source references', () => {
    const report = serializeDiagnosticResult({
      upgrade: '101',
      respq: 'complete',
      respq_nonce_match: true,
      fingerprint_in_pinned_set: true,
      pq_valid: true,
      dh_reply: 'ok',
      dh_inner_valid: true,
      close_1000_sent: true,
      result: 'dh_inner_valid',
      source_ref: 'a'.repeat(40),
      deploy_ref: 'MAIN-1633',
      run_ref: 'MAIN-1653',
      endpoint: 'wss://attacker.example.test/apiws',
      error: 'ATTACKER_CONTROLLED_ERROR',
      nonce: 'ATTACKER_CONTROLLED_NONCE',
      dh_prime: 'ATTACKER_CONTROLLED_DH'
    });

    expect(report).toEqual({
      upgrade: '101',
      respq: 'complete',
      respq_nonce_match: true,
      fingerprint_in_pinned_set: true,
      pq_valid: true,
      dh_reply: 'ok',
      dh_inner_valid: true,
      close_1000_sent: true,
      result: 'dh_inner_valid',
      source_ref: 'a'.repeat(40),
      deploy_ref: 'MAIN-1633',
      run_ref: 'MAIN-1653'
    });
    expect(JSON.stringify(report)).not.toContain('attacker.example.test');
    expect(JSON.stringify(report)).not.toContain('ATTACKER_CONTROLLED');
  });

  it('omits stages that the attempt did not reach', () => {
    const report = serializeDiagnosticResult({
      upgrade: '101',
      respq: 'timeout',
      close_1000_sent: true,
      result: 'unknown',
      source_ref: 'b'.repeat(40),
      deploy_ref: unknownReference,
      run_ref: unknownReference
    });

    expect(report).toEqual({
      upgrade: '101',
      respq: 'timeout',
      close_1000_sent: true,
      result: 'unknown',
      source_ref: 'b'.repeat(40),
      deploy_ref: unknownReference,
      run_ref: unknownReference
    });
    expect(report).not.toHaveProperty('respq_nonce_match');
    expect(report).not.toHaveProperty('fingerprint_in_pinned_set');
    expect(report).not.toHaveProperty('pq_valid');
    expect(report).not.toHaveProperty('dh_reply');
    expect(report).not.toHaveProperty('dh_inner_valid');
  });

  it('preserves only the fixed DH refusal and protocol code enums', () => {
    const report = serializeDiagnosticResult({
      dh_reply: 'fail',
      proto_error_code: '429',
      result: 'dh_reply_refused',
      source_ref: 'c'.repeat(40),
      deploy_ref: 'MAIN-1633',
      run_ref: 'MAIN-1653',
      error: 'ATTACKER_CONTROLLED_ERROR'
    });

    expect(report).toEqual({
      dh_reply: 'fail',
      proto_error_code: '429',
      result: 'dh_reply_refused',
      source_ref: 'c'.repeat(40),
      deploy_ref: 'MAIN-1633',
      run_ref: 'MAIN-1653'
    });
  });
});
