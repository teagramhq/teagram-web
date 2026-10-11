import {generateKeyPairSync} from 'node:crypto';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {normalizeRuntimeInput, sanitizeReport, superviseAttempt} from './l1PrekeyRun.mjs';

function runtimeInput() {
  const {publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  return {
    endpoint: 'wss://diagnostic.example.test/apiws',
    origin: 'https://web.example.test',
    subprotocol: 'binary',
    dc_id: 2,
    fingerprint: '0123456789abcdef',
    public_key: publicKey.export({format: 'pem', type: 'spki'}).toString(),
    source_ref: 'a'.repeat(40),
    deploy_ref: 'MAIN-1633',
    run_ref: 'MAIN-1653',
    attacker_payload: 'ATTACKER_CONTROLLED_INPUT'
  };
}

describe('L1 pre-key runner boundary', () => {
  it('drops every output field outside the fixed diagnostic schema', () => {
    const report = sanitizeReport({
      upgrade: '101',
      respq: 'complete',
      respq_nonce_match: true,
      dh_reply: 'ok',
      dh_inner_valid: true,
      close_1000_sent: false,
      result: 'dh_inner_valid',
      source_ref: 'a'.repeat(40),
      deploy_ref: 'MAIN-1633',
      run_ref: 'MAIN-1653',
      endpoint: 'wss://attacker.example.test/apiws',
      error: 'ATTACKER_CONTROLLED_ERROR',
      nonce: 'ATTACKER_CONTROLLED_NONCE',
      key: 'ATTACKER_CONTROLLED_KEY'
    });

    expect(report).toEqual({
      upgrade: '101',
      respq: 'complete',
      dh_reply: 'ok',
      respq_nonce_match: true,
      dh_inner_valid: true,
      close_1000_sent: false,
      result: 'dh_inner_valid',
      source_ref: 'a'.repeat(40),
      deploy_ref: 'MAIN-1633',
      run_ref: 'MAIN-1653'
    });
    expect(JSON.stringify(report)).not.toMatch(/attacker\.example|ATTACKER_CONTROLLED/);
  });

  it('accepts only public RSA runtime inputs and discards unknown fields', () => {
    const supplied = runtimeInput();
    const normalized = normalizeRuntimeInput(supplied);

    expect(normalized).toMatchObject({
      origin: supplied.origin,
      subprotocol: 'binary',
      dc_id: 2,
      source_ref: supplied.source_ref,
      deploy_ref: supplied.deploy_ref,
      run_ref: supplied.run_ref,
      target: {
        mode: 'private',
        endpoint: supplied.endpoint,
        fingerprint: supplied.fingerprint,
        routeLock: {transport: 'websocket'}
      }
    });
    expect(normalized).not.toHaveProperty('attacker_payload');
    expect(normalizeRuntimeInput({...supplied, public_key: '-----BEGIN PRIVATE KEY-----'})).toBeUndefined();
    expect(normalizeRuntimeInput({...supplied, origin: 'https://user:password@web.example.test'})).toBeUndefined();
  });

  it('loads the shipped validation in an isolated child without opening a socket for an inconsistent pin', async() => {
    const input = normalizeRuntimeInput(runtimeInput());
    expect(input).toBeDefined();
    const report = await superviseAttempt(input, Date.now() + 15_000);

    expect(report).toEqual({
      result: 'invalid_input',
      source_ref: 'a'.repeat(40),
      deploy_ref: 'MAIN-1633',
      run_ref: 'MAIN-1653'
    });
  });

  it('returns unknown when a child crashes and suppresses its stderr', async() => {
    const crashScript = resolve(process.cwd(), 'src/tests/fixtures/l1PrekeyRunnerCrash.mjs');
    const report = await superviseAttempt({
      source_ref: 'a'.repeat(40),
      deploy_ref: 'MAIN-1633',
      run_ref: 'MAIN-1653'
    }, Date.now() + 1_000, {childPath: crashScript, timeoutMs: 2_000});

    expect(report).toEqual({
      result: 'unknown',
      source_ref: 'a'.repeat(40),
      deploy_ref: 'MAIN-1633',
      run_ref: 'MAIN-1653'
    });
    expect(JSON.stringify(report)).not.toContain('ATTACKER_CONTROLLED_CRASH');
  });

  it('kills a child at the supervisor deadline and emits an unknown result', async() => {
    const hangScript = resolve(process.cwd(), 'src/tests/fixtures/l1PrekeyRunnerHang.mjs');
    const started = Date.now();
    const report = await superviseAttempt({source_ref: 'b'.repeat(40)}, started + 100, {
      childPath: hangScript,
      timeoutMs: 100
    });

    expect(report).toMatchObject({result: 'unknown', source_ref: 'b'.repeat(40)});
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
