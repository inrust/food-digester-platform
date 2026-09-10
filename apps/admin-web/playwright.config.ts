import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
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
