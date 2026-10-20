import {defineConfig, devices} from '@playwright/test';

const PORT = Number(process.env.TWEB_PRIVATE_AUTH_PORT || 8101);

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env.TWEB_PRIVATE_AUTH_OUTPUT_DIR || 'test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    headless: true,
    ignoreHTTPSErrors: true,
    // The custom server sign-in smoke serves both hosts from its TLS listener on 18443.
    // ignoreHTTPSErrors does not reach SharedWorker sockets, so its self-signed certificate needs the flag.
    launchOptions: {args: ['--ignore-certificate-errors', '--host-resolver-rules=MAP second-server.example.test:443 127.0.0.1:18443, MAP web.teagram.io:443 127.0.0.1:18443, MAP second-server.example.test 127.0.0.1']},
    viewport: {width: 320, height: 720}
  },
  projects: [
    {
      name: 'private-auth-chromium',
      testIgnore: /customServerLocalSignIn\.spec\.ts/,
      use: {...devices['Desktop Chrome']}
    },
    {
      name: 'chromium',
      testMatch: /customServerLocalSignIn\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        trace: {
          mode: 'retain-on-failure',
          screenshots: false,
          snapshots: false,
          sources: false,
          attachments: false
        }
      }
    }
  ],
  webServer: {
    command: `corepack pnpm --config.verify-deps-before-run=false exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    env: {
      TWEB_PREVIEW: '1',
      MTPROTO_TARGET_MODE: process.env.MTPROTO_TARGET_MODE || 'private',
      MTPROTO_PRIVATE_ENDPOINT: process.env.MTPROTO_PRIVATE_ENDPOINT || 'wss://private.example.test/apiws',
      MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: process.env.MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE || 'scripts/fixtures/private-mtproto-public.pem'
    },
    reuseExistingServer: false,
    timeout: 120_000
  }
});
