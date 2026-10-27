import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {defineConfig, devices} from '@playwright/test';

const PORT = 8102;
const manifest = JSON.parse(readFileSync(resolve('dist/mtproto-target.json'), 'utf8')) as {mode: string, endpoint: string};
if(manifest.mode !== 'private') throw new Error('private artifact browser tests require a private build');
const endpoint = new URL(manifest.endpoint);
const targetPorts = new Set([443, Number(endpoint.port || 443)]);
const hostResolverRules = [
  'MAP web.teagram.io:443 127.0.0.1:18443',
  ...[...targetPorts].map((port) => `MAP ${endpoint.hostname}:${port} 127.0.0.1:18443`),
  'MAP cancel-server.example.test:443 127.0.0.1:18443',
  'MAP cancel-server.example.test:18443 127.0.0.1:18443'
].join(', ');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800}
  },
  projects: [
    {
      name: 'private-artifact-chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {args: ['--ignore-certificate-errors', `--host-resolver-rules=${hostResolverRules}`]}
      }
    },
    {name: 'private-artifact-firefox', use: {...devices['Desktop Firefox']}}
  ],
  webServer: {
    command: `corepack pnpm --config.verify-deps-before-run=false exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
