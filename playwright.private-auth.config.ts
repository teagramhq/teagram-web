import {defineConfig, devices} from '@playwright/test';

const PORT = Number(process.env.TWEB_PRIVATE_AUTH_PORT || 8101);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    headless: true,
    viewport: {width: 320, height: 720}
  },
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
  webServer: {
    command: `corepack pnpm --config.verify-deps-before-run=false exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    env: {
      TWEB_PREVIEW: '1',
      MTPROTO_TARGET_MODE: 'private',
      MTPROTO_PRIVATE_ENDPOINT: 'wss://private.example.test/apiws',
      MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE: 'scripts/fixtures/private-mtproto-public.pem'
    },
    reuseExistingServer: false,
    timeout: 120_000
  }
});
