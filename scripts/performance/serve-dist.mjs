import compression from 'compression';
import express from 'express';
import {resolve} from 'node:path';

const [directory, portValue] = process.argv.slice(2);
if(!directory || !portValue) throw new Error('usage: serve-dist.mjs <dist-directory> <port>');
const root = resolve(directory);
const port = Number(portValue);
if(!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${portValue}`);

const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use(express.static(root, {index: false, fallthrough: true}));
app.get(/.*/, (_request, response) => response.sendFile(resolve(root, 'index.html')));
app.listen(port, '127.0.0.1', () => process.stdout.write(`Serving ${root} on ${port}\n`));
