import {appendFileSync, readFileSync} from 'node:fs';

const [readmePath] = process.argv.slice(2);
if(!readmePath) throw new Error('usage: read-credentials.mjs <server test/perf/README.md>');
const readme = readFileSync(readmePath, 'utf8');
const match = /fixture owner can sign in with username\s+`([^`]+)`\s+and\s+password\s+`([^`]+)`/i.exec(readme);
if(!match) throw new Error('fixture owner username and password were not found in test/perf/README.md');
if(process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `PERF_USERNAME=${match[1]}\nPERF_PASSWORD=${match[2]}\n`);
} else {
  process.stdout.write(`${match[1]}\n${match[2]}\n`);
}
