import { createRequire } from 'node:module';
import { defineConfig, mergeConfig } from 'vitest/config';
import root from '../../vitest.config.mjs';
const requireAws = createRequire(new URL('../../packages/aws-clients/package.json', import.meta.url));
const config = mergeConfig(
  root,
  defineConfig({
    resolve: {
      alias: Object.fromEntries(
        ['@aws-sdk/client-cognito-identity-provider', '@aws-sdk/client-secrets-manager'].map((p) => [
          p,
          requireAws.resolve(p),
        ]),
      ),
    },
    test: {
      include: ['tools/img21/test/**/*.test.ts'],
      fileParallelism: false,
      testTimeout: 30000,
      hookTimeout: 60000,
    },
  }),
);

config.test!.include = ['tools/img21/test/**/*.test.ts'];
export default config;
