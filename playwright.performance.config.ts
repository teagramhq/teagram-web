import {defineConfig, devices} from '@playwright/test';

const hostResolverRules = [
  'MAP teagramd.test:443 127.0.0.1:18443'
].join(', ');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60 * 60 * 1000,
  reporter: [['list']],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: {width: 1280, height: 800}
  },
  projects: [{
    name: 'performance-chromium',
    use: {
      ...devices['Desktop Chrome'],
      ignoreHTTPSErrors: true,
      launchOptions: {args: [`--host-resolver-rules=${hostResolverRules}`, '--ignore-certificate-errors']}
    }
  }]
});
