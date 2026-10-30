const targetByOrigin = new Map([
  ['http://localhost:4173', {http: 'http://127.0.0.1:2445', websocket: 'ws://127.0.0.1:2445'}],
  ['http://localhost:4174', {http: 'http://127.0.0.1:2445', websocket: 'ws://127.0.0.1:2445'}],
  ['http://localhost:4175', {http: 'http://127.0.0.1:2446', websocket: 'ws://127.0.0.1:2446'}],
  ['http://localhost:4176', {http: 'http://127.0.0.1:2446', websocket: 'ws://127.0.0.1:2446'}]
]);

export function targetForOrigin(origin) {
  return targetByOrigin.get(origin);
}

export function targetFor(host, origin) {
  if(host !== 'teagramd.test') return undefined;
  return targetForOrigin(origin);
}
