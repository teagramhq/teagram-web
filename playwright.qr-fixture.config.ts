import {defineConfig, devices} from '@playwright/test';

const PORT = 8173;
const baseURL = `http://127.0.0.1:${PORT}/`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results/qr-fixture',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    headless: true,
    viewport: {width: 1024, height: 768},
    serviceWorkers: 'block',
    screenshot: 'off',
    video: 'off',
    trace: 'off'
  },
  projects: [{name: 'qr-fixture-chromium', use: {...devices['Desktop Chrome']}}],
  webServer: {
    command: `env -i PATH="$PATH" HOME="$HOME" MTPROTO_TARGET_MODE=private MTPROTO_PRIVATE_ENDPOINT=wss://qr-fixture.invalid/ MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE=scripts/fixtures/private-mtproto-public.pem VITE_MTPROTO_AUTO= VITE_MTPROTO_HAS_HTTP= VITE_MTPROTO_HAS_WS=true VITE_MTPROTO_HTTP= VITE_MTPROTO_HTTP_UPLOAD= VITE_MTPROTO_SW= VITE_MTPROTO_WORKER= corepack pnpm exec vite --config vite.config.ts --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
