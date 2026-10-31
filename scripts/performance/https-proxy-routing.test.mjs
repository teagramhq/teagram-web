import assert from 'node:assert/strict';
import test from 'node:test';
import {targetFor, targetForOrigin} from './https-proxy-routing.mjs';

test('routes each web origin to its matching fixture server', () => {
  assert.deepEqual(targetForOrigin('http://localhost:4173'), {
    http: 'http://127.0.0.1:2445',
    websocket: 'ws://127.0.0.1:2445'
  });
  assert.deepEqual(targetForOrigin('http://localhost:4174'), {
    http: 'http://127.0.0.1:2445',
    websocket: 'ws://127.0.0.1:2445'
  });
  assert.deepEqual(targetForOrigin('http://localhost:4175'), {
    http: 'http://127.0.0.1:2446',
    websocket: 'ws://127.0.0.1:2446'
  });
  assert.deepEqual(targetForOrigin('http://localhost:4176'), {
    http: 'http://127.0.0.1:2446',
    websocket: 'ws://127.0.0.1:2446'
  });
  assert.deepEqual(targetForOrigin('http://localhost:4177'), {
    http: 'http://127.0.0.1:2446',
    websocket: 'ws://127.0.0.1:2446'
  });
});

test('rejects unrecognized browser origins', () => {
  assert.equal(targetForOrigin('https://localhost:4173'), undefined);
  assert.equal(targetForOrigin(undefined), undefined);
  assert.equal(targetFor('attacker.test', 'http://localhost:4173'), undefined);
});
