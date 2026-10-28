import {readFileSync} from 'node:fs';
import {createServer} from 'node:https';
import httpProxy from 'http-proxy';

const proxy = httpProxy.createProxyServer({xfwd: true, changeOrigin: false});
const tlsKeyPath = process.env.PERF_TLS_KEY;
const tlsCertPath = process.env.PERF_TLS_CERT;
if(!tlsKeyPath || !tlsCertPath) throw new Error('PERF_TLS_KEY and PERF_TLS_CERT are required');

const targetFor = (host) => {
  if(host === 'teagramd.test') return 'http://127.0.0.1:2445';
  return undefined;
};
const hostname = (request) => (request.headers.host || '').split(':')[0].toLowerCase();

proxy.on('error', (error, _request, responseOrSocket) => {
  process.stderr.write(`${error.message}\n`);
  if('writeHead' in responseOrSocket) {
    responseOrSocket.writeHead(502);
    responseOrSocket.end('performance proxy target unavailable');
  } else {
    responseOrSocket.destroy();
  }
});

const server = createServer({key: readFileSync(tlsKeyPath), cert: readFileSync(tlsCertPath)}, (request, response) => {
  const target = targetFor(hostname(request));
  if(!target) {
    response.writeHead(404);
    response.end('unknown performance host');
    return;
  }
  proxy.web(request, response, {target});
});

server.on('upgrade', (request, socket, head) => {
  if(hostname(request) !== 'teagramd.test') {
    socket.destroy();
    return;
  }
  proxy.ws(request, socket, head, {target: 'ws://127.0.0.1:2445'});
});

server.listen(18443, '127.0.0.1', () => process.stdout.write('HTTPS performance proxy listening on 18443\n'));
