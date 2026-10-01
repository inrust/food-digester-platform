import { defineConfig } from 'vitest/config';
import base from './vitest.config.mjs';
import { QA06_FILES } from './scripts/qa06-manifest.mjs';
export default defineConfig({ ...base, test: { ...base.test, include: QA06_FILES } });
