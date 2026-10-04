import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  ...(process.env.UI_COMPAT_RUN
    ? {
        projects: [
          { name: 'chromium', use: { browserName: 'chromium' as const } },
          { name: 'chrome', use: { browserName: 'chromium' as const, channel: 'chrome' } },
          { name: 'firefox', use: { browserName: 'firefox' as const } },
          { name: 'edge', use: { browserName: 'chromium' as const, channel: 'msedge' } },
        ],
      }
    : {}),
  ...(process.env.QA08_RUN ? { testMatch: 'qa08-prototype.spec.ts' } : { testIgnore: 'qa08-prototype.spec.ts' }),
  fullyParallel: process.env.QA05_PHASE === 'parallel-repeat',
  workers: process.env.UI_COMPAT_RUN ? 3 : process.env.QA05_PHASE === 'parallel-repeat' ? 2 : 1,
  repeatEach: process.env.QA05_PHASE === 'parallel-repeat' ? 2 : 1,
  retries: 0,
  reporter: process.env.QA08_REPORT
    ? [['line'], ['json', { outputFile: process.env.QA08_REPORT }]]
    : process.env.QA05_REPORT
      ? [['line'], ['json', { outputFile: process.env.QA05_REPORT }]]
      : 'line',
  ...(process.env.QA08_OUTPUT_DIR ? { outputDir: process.env.QA08_OUTPUT_DIR } : {}),
  ...(process.env.QA05_OUTPUT_DIR ? { outputDir: process.env.QA05_OUTPUT_DIR } : {}),
  use: {
    headless: true,
    serviceWorkers: 'block',
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm start --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/login',
    reuseExistingServer: false,
    env: {
      VITE_ADMIN_API_BASE_URL: '/api/v1',
      VITE_COGNITO_REGION: 'us-east-1',
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_local',
      VITE_COGNITO_CLIENT_ID: 'local-client',
    },
  },
});
