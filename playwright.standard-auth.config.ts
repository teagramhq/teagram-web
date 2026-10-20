import {defineConfig, devices} from '@playwright/test';

const PORT = Number(process.env.TWEB_STANDARD_AUTH_PORT || 8102);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    headless: true,
    viewport: {width: 412, height: 915}
  },
  projects: [{name: 'chromium', use: {...devices['Pixel 7']}}],
  webServer: {
    command: `corepack pnpm --config.verify-deps-before-run=false exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    env: {
      TWEB_PREVIEW: '1',
      MTPROTO_TARGET_MODE: 'telegram'
    },
    reuseExistingServer: false,
    timeout: 120_000
  }
});
