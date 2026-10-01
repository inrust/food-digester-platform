import { defineConfig } from 'vitest/config';
import base from './vitest.config.mjs';
import { QA04_FILES } from './scripts/qa04-manifest.mjs';
export default defineConfig({
  ...base,
  test: { ...base.test, include: QA04_FILES, setupFiles: ['apps/cloud-api/test/qa04-observe.ts'] },
});
